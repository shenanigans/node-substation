
var EventEmitter = require ('events').EventEmitter;
var async = require ('async');
var MultimediaStream = require ('./MultimediaStream');

// normalize WebRTC primitives
var PeerConnection =
    window.RTCPeerConnection
 || window.mozRTCPeerConnection
 || window.webkitRTCPeerConnection
 ;
var SessionDescription =
    window.RTCSessionDescription
 || window.mozRTCSessionDescription
 || window.webkitRTCSessionDescription
 ;
var ICECandidate =
    window.RTCIceCandidate
 || window.mozRTCIceCandidate
 || window.webkitRTCIceCandidate
 ;

/**     @class substation.Peer
    @root
    @super events.EventEmitter
    Represents a WebRTC Link between two Users or Clients. Calling `emit` on a Peer emits an event
    from connected Peer instances on the client machine. Remote calls to `emit` will emit events on
    this local Peer instance.

    A Peer is a connection pool, broadcasting outgoing events and streams to, and multiplexing
    incoming events from, every remote client selected by the [Link query](#connect). The formation
    of a Link will cause new Peers to be created in this user's other applicable agents, and new
    agents will join the Link automatically for as long as both ends maintain at least one
    connection to the signaling server.

    Do not attempt to instantiate a Peer directly, just get one from [a Server instance]
    (substation.Server#getPeer).
@spare `Archeological Notes`
    Archeological Notes
    ------------------
    WebRTC is an awful, horrible, despicable API which is poorly implemented by all browser vendors.
    What follows is a discussion of how the workarounds function.

    Renegotiation
    =============
    WebRTC is only spec'd to renegotiate a connection in the direction is was originally
    established, i.e. the partner who created the SDP offer may do so again but the partner who
    created the answer must live with the connection as-is. At time of writing, Firefox is only
    capable of renegotiating a stream correctly in the forward direction on OSX. Therefor, no
    connection is ever renegotiated - it is replaced with a brand new connection.

    Stream Parity
    =============
    If you receive an SDP offer that contains no streams, you may not establish your own stream
    with the SDP answer. Everything will appear to work fine but your streams won't appear on the
    opposite end. Here, whenever [renegotiate](#renegotiate) is called, the number of outgoing
    streams is checked. If it's zero, the opposite end is signalled to start the renegotiation.

    Keepalives
    ==========
    Firefox will drop a `DataChannel` if you don't use it continuously. Thankfully they can be
    "used" in a way which does not interfere with normal signalling. Each end of each connection
    offers a `DataChannel` intended for single-duplex use and sends keepalive pings back on the
    opposite channel where there is no event listener.
@argument/substation.Server server
    The domain server used to control signaling. WebRTC configuration options (ICE Server URLs) are
    configured [on the server](substation.Server#Options)
@argument/Object query
    The query used to select the remote Peer for outgoing connections, or the identity doc for the
    remote Peer for incoming connections. This is recommended to be representative of the query that
    would select the remote Peer if an outgoing connection were made, however this is [up to the
    application.](substation+peerRequest)
@argument/Object msg
    @optional
    For incoming connections: the message Object that initiated the Peer connection, potentially
    containing an SDP offer.
@event connect
    At least one remote Peer is connected and available to emit events.
@event close
    All remote Peers have disconnected and there is nobody left to receive events. Note that the
    Peer instance is not dead, as it can attempt to reconnect later, or receive an incoming
    connection.
@event error
    An unexpected failure has prevented connection or forced disconnection and there are no
    available remote Peers at this time. Note that the Peer instance is not dead, as it can attempt
    to reconnect later, or receive an incoming connection.
@event stream
    A [MediaStream](substation.MediaStream) has been sent by a remote Peer and is now available to
    consume. Courtesy of the WebRTC api, these streams are emitted midway through connection
    renegotiation and may not begin receiving data for some time.
    @optional
*/
function Peer (server, query, msg) {
    window.lastPeer = this;
    this.server = server;
    this.query = query;

    this.connected = false;
    this.connecting = false;
    this.iceBox = {};
    this.isPeer = true;
    this.sockets = {};
    this.transmitChannels = [];
    this.liveSockets = 0;
    this.outgoingStreams = [];
    this.incomingStreams = {};

    this.emitter = new EventEmitter();
    var self = this;
    this.emitter.on ('newListener', function (event, listener) {
        if (event == 'connect' && self.connected)
            listener();
    });

    if (!msg)
        return;

    // incoming peer - received init or offer
    this.token = msg.token;
    var socket = new PeerConnection({ iceServers:server.iceServers });
    this.assimilateSocket (socket, msg.from);

    if (msg.sdp && msg.sdp.type == 'offer') {
        socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
            socket.createAnswer (function (answer) {
                socket.setLocalDescription (answer, function(){
                    self.releaseICE (socket);
                    server.sendPeerMessage ({ token:msg.token, to:msg.from, sdp:answer });
                }, function (err) {
                    console.log ('setLocalDescription error', err);
                });
            }, function (err) {
                console.log ('createAnswer error', err);
            });
        }, function (err) {
            console.log ('setRemoteDescription error', err);
        });
    } else {
        socket.createOffer (function (offer) {
            socket.setLocalDescription (new SessionDescription (offer), function(){
                server.sendPeerMessage ({ token:msg.token, to:msg.from, sdp:offer });
            }, function (err) {
                console.log ('setLocalDescription error', err);
            });
        }, function (err) {
            console.log ('createOffer error', err);
        });
    }

    process.nextTick (function(){
        server.emit ('incomingPeer', self);
    });
}


/**     @member/Function releaseICE
    @private
    Releases queued ICE messages to a [socket](RTCPeerConnection) by its SID and ceases queueing
    ICE messages for this SID. The socket's `ready` property is set to `true`.
@argument/RTCPeerConnection readySocket
    A [socket](RTCPeerConnection) that is ready to receive ICE messages.
*/
Peer.prototype.releaseICE = function (socket) {
    // release ICE
    if (Object.hasOwnProperty.call (this.iceBox, socket.SID)) {
        var tray = this.iceBox[socket.SID];
        for (var i=0,j=tray.length; i<j; i++)
            socket.addIceCandidate (new ICECandidate (tray[i]));
        delete this.iceBox[socket.SID];
    }
    socket.ready = true;
};


/**     @member/Function assimilateSocket
    @private
    Prepares a new WebRTC socket for use by the Peer. Attaches event listeners for ICE negotiation,
    [stream closure](#dropSocket) when [errors occur](RTCDataChannel#onerror), [media streams]
    (substation.MultimediaStream) open. Attaches event listeners to incoming [data channels]
    (RTCDataChannel). Opens a new [DataChannel](RTCDataChannel) for event passing over the native
    stream and attaches event listeners to it.

    The new [data channel](RTCDataChannel) is appended to [this.transmitChannels]
    (#transmitChannels). When the first transmit channel [opens](RTCDataChannel#onopen) the
    [connect](+connect) event is emitted. Every newly connected [transmit channel](RTCDataChannel)
    triggers the [socketConnect](+socketConnect) event.
@argument/RTCPeerConnection socket
@argument/String SID
*/
var nextDebug = 1;
Peer.prototype.assimilateSocket = function (socket, SID) {
    var self = this;
    var transmitChannels = this.transmitChannels;
    if (!Object.hasOwnProperty.call (this.sockets, SID))
        this.liveSockets++;
    this.sockets[SID] = socket;
    socket.SID = SID;

    var transmitChannel = socket.createDataChannel ('transmit', { reliable:true });
    transmitChannel.socket = socket;
    socket.transmitChannel = transmitChannel;

    for (var i=0,j=this.outgoingStreams.length; i<j; i++)
        socket.addStream (this.outgoingStreams[i]);

    transmitChannel.onerror = function(){
        self.dropSocket (socket);
    };

    transmitChannel.onclose = function(){
        self.dropSocket (socket);
    };

    transmitChannel.onopen = function (event) {
        if (transmitChannel.readyState != 'open') return;
        // cull redundant transmission channels
        for (var i=0,j=transmitChannels.length; i<j; i++)
            if (transmitChannels[i].socket.SID == socket.SID) {
                transmitChannels[i].close();
                transmitChannels.splice (i, 1);
                i--; j--;
            }
        socket.connected = true;
        transmitChannels.push (transmitChannel);
        if (!self.connected) {
            self.connecting = false;
            self.connected = true;
            process.nextTick (function(){
                self.emitter.emit ('connect');
                self.server.emit ('peer', self);
                if (self.connectionQueue) {
                    for (var i=0,j=self.connectionQueue.length; i<j; i++)
                        self.connectionQueue[i]();
                    delete self.connectionQueue;
                }
            });
        }
        self.emitter.emit ('socketConnect', SID);
    };


    socket.onicecandidate = function (event) {
        if (!event.candidate)
            return;

        if (socket.parent) {
            if (socket.parent.connected)
                socket.parent.transmitChannel.send (JSON.stringify ({ ICE:event.candidate }));
            return;
        }

        self.server.sendPeerMessage (
            { token:self.token, ICE:JSON.stringify (event.candidate), to:SID }
        );
    };

    socket.ondatachannel = function (event) {
        var channel = event.channel;

        channel.onerror = function(){
            self.dropSocket (socket);
        };

        channel.onclose = function(){
            self.dropSocket (socket);
        };

        channel.onmessage = function (event) {
            var msg = JSON.parse (event.data);
            if (msg.event)
                self.emitter.emit.apply (self.emitter, msg.event);
            var child = socket.child;

            if (msg.ICE && child) {
                if (child.ready)
                    child.addIceCandidate (new ICECandidate (msg.ICE));
                else
                     if (Object.hasOwnProperty.call (self.iceBox, SID))
                        self.iceBox[SID].push (msg.ICE);
                    else
                        self.iceBox[SID] = [ msg.ICE ];
            }

            if (msg.removeStreams)
                for (var i=msg.removeStreams.length-1; i>=0; i--)
                    try {
                        self.incomingStreams[SID].splice (msg.removeStreams[i], 1)[0].close();
                    } catch (err) {
                        console.log (
                            'requested to remove stream at invalid index ('
                          + msg.removeStreams[i]
                          + ')'
                        );
                    }

            if (msg.renegotiate) {
                self.renegotiate (undefined, true);
                return;
            }

            if (!msg.sdp)
                return;

            if (msg.sdp.type == 'answer') {
                if (!child)
                    return;
                // concluding a renegotiation request already in progress
                child.setRemoteDescription (
                    new SessionDescription (msg.sdp),
                    function(){ self.releaseICE (child); },
                    function (err) {
                        console.log ('renegotiation remote answer setRemoteDescription error', err);
                    }
                );
                return;
            }

            // accepting renegotiation request

            var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
            socket.child = newSocket;
            newSocket.parent = socket;
            self.assimilateSocket (newSocket, SID);
            self.emitter.on ('socketConnect', function dropSocket (openSID) {
                if (openSID != SID)
                    return;
                try { socket.close(); } catch (err) { /* throws if already closed */ }
                self.emitter.removeListener ('socketConnect', dropSocket);
            });
            newSocket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                newSocket.createAnswer (function (answer) {
                    newSocket.setLocalDescription (new SessionDescription (answer), function(){
                        self.releaseICE (newSocket);
                        socket.transmitChannel.send (JSON.stringify ({ sdp:answer }));
                    }, function (err) {
                        console.log ('setLocalDescription error', err);
                    });
                }, function (err) {
                    console.log ('createAnswer error', err);
                });
            }, function (err) {
                console.log ('setRemoteDescription error', err);
            });
        };

        // connected when channel is ready
        channel.onopen = function(event) {
            if (channel.readyState != 'open') return;
            socket.connected = true;

            // keepalive pings
            // connections between chrome and firefox will die without these
            var keepalive = window.setInterval (function(){
                try {
                    channel.send ('ping');
                } catch (err) {
                    window.clearInterval (keepalive);
                    self.dropSocket (socket);
                }
            }, 500);

            if (!self.connected) {
                self.connecting = false;
                self.connected = true;
                self.emitter.emit ('connect');
                self.server.emit ('peer', self);
                if (self.connectionQueue) {
                    for (var i=0,j=self.connectionQueue.length; i<j; i++)
                        self.connectionQueue[i]();
                    delete self.connectionQueue;
                }
            }
        };
    }

    socket.onaddstream = function (event) {
        var stream = event.stream;
        var index = socket.streamIndex || (socket.streamIndex = 0);
        socket.streamIndex++;
        var incomingStreams = Object.hasOwnProperty.call (self.incomingStreams, SID) ?
            self.incomingStreams[SID]
          : (self.incomingStreams[SID] = [])
          ;
        if (incomingStreams.length > index) {
            // add a replacement native to an existing stream
            incomingStreams[index].addReplacement (stream);
            incomingStreams[index].swapNatives();
        } else {
            // create and announce a new stream
            var wrappedStream = new MultimediaStream (stream);
            incomingStreams.push (wrappedStream);
            self.emitter.emit ('stream', wrappedStream);
        }
    }

    function fatalError (event) {
        self.dropSocket (socket);
    }
    socket.onidpassertionerror = fatalError;
    socket.onidpvalidationerror = fatalError;
};


/**     @member/Function dropSocket
    @development
    Removes a closed or unnecessary socket from the active sockets, potentially emitting the `close`
    or `error` event.
*/
Peer.prototype.dropSocket = function (socket) {
    var found = false;
    try { // for some reason, firefox throws an error if the socket is already closed
        socket.close();
    } catch (err) {}

    for (var i=0,j=this.transmitChannels.length; i<j; i++)
        if (this.transmitChannels[i].socket === socket) {
            this.transmitChannels.splice (i, 1);
            found = true;
            break;
        }
    if (
        !Object.hasOwnProperty.call (this.sockets, socket.SID)
     || this.sockets[socket.SID] !== socket
    )
        return found;

    delete this.sockets[socket.SID];
    delete this.iceBox[socket.SID];

    this.liveSockets = Math.max (0, this.liveSockets - 1);
    if (this.liveSockets) return true;

    if (!this.connected)
        this.emitter.emit ('error', new Error ('connection failed'));
    this.connected = false;
    this.connecting = false;

    this.emitter.emit ('close');
    this.server.emit ('peerDisconnect', this);
    return true;
};


/**     @member/Function connect
    @api
    Connect to remote Peers, if not connected already. This is the entry point for initializing an
    outgoing Peer connection. A custom query Object is serialized and [sent to the server]
    (substation+peerRequest) to select a User or Client.
@callback
    @argument/Error|undefined error
    @argument/Boolean accepted
*/
Peer.prototype.connect = function (callback) {
    if (this.connected) {
        process.nextTick (callback);
        return;
    }
    if (callback)
        (this.connectionQueue || (this.connectionQueue = [])).push (callback);
    if (this.connecting)
        return;
    this.connecting = true;
    this.server.connectPeer (this.query);
    this.server.emit ('outgoingPeer', this);
};


/**     @member/Function renegotiate

*/
Peer.prototype.renegotiate = function (removeIndexes, forced) {
    var self = this;
    async.each (Object.keys (this.sockets), function (sid, callback) {
        var socket = self.sockets[sid];
        if (!socket.connected) {
            console.log ('socket not connected');
            return callback();
        }

        if (self.outgoingStreams.length || forced) {
            var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
            socket.child = newSocket;
            newSocket.parent = socket;
            self.assimilateSocket (newSocket, sid);
            newSocket.createOffer (function (offer) {
                newSocket.setLocalDescription (offer, function(){
                    var message = { sdp:offer };
                    if (removeIndexes)
                        message.removeStreams = removeIndexes;
                    socket.transmitChannel.send (JSON.stringify (message));
                }, function (err) {
                    console.log ('renegotiation setLocalDescription error', err);
                });
            }, function (err) {
                console.log ('renegotiation createOffer error', err);
            });
        } else {
            var message = { renegotiate:true };
            if (removeIndexes)
                message.removeStreams = removeIndexes;
            socket.transmitChannel.send (JSON.stringify (message));
        }
        self.emitter.on ('socketConnect', function dropSocket (openSID) {
            if (openSID != sid) return;
            try { socket.close(); } catch (err) { /* throws if already closed */ }
            self.emitter.removeListener ('socketConnect', dropSocket);
            callback();
        });
    }, function (err) {
        console.log ('renegotiation complete');
    });
};


/**     @member/Function processPeerMessage
    @development
    React to a peer signal Object from the server.
@argument/Object msg
*/
Peer.prototype.processPeerMessage = function (msg) {
    if (msg.token)
        this.token = msg.token;
    if (!msg.from)
        return;

    // console.log ('peer message: '+(msg.sdp ? msg.sdp.type : msg.ICE ? msg.ICE : 'init')+' from '+msg.from);

    var socket;
    var self = this;

    // init
    if (msg.init && !Object.hasOwnProperty.call (this.sockets, msg.from)) {
        socket = new PeerConnection ({ iceServers:this.server.iceServers });
        this.assimilateSocket (socket, msg.from);
        socket.createdOffer = true;
        socket.createOffer (function (offer) {
            socket.setLocalDescription (new SessionDescription (offer), function(){
                self.server.sendPeerMessage ({ token:msg.token, to:msg.from, sdp:offer });
            }, function (err) {
                console.log ('setLocalDescription error', err);
            });
        }, function (err) {
            console.log ('createOffer error', err);
        });
    }

    // sdp
    if (msg.sdp) {
        if (msg.sdp.type == 'answer') { // SDP Answer received
            if (!Object.hasOwnProperty.call (this.sockets, msg.from))
                return;
            socket = this.sockets[msg.from];
            socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                self.releaseICE (socket);
            }, function (err) {
                console.log ('incoming answer error', err);
            });
            return;
        }

        // SDP Offer received
        if (Object.hasOwnProperty.call (this.sockets, msg.from))
            socket = this.sockets[msg.from];
        else {
            socket = new PeerConnection ({ iceServers:self.server.iceServers });
            this.assimilateSocket (socket, msg.from);
        }
        socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
            socket.createAnswer (function (answer) {
                socket.setLocalDescription (answer, function(){
                    self.releaseICE (socket);
                    self.server.sendPeerMessage ({ token:self.token, sdp:answer, to:msg.from });
                }, function (err) {
                    console.log ('setLocalDescription error', err, err.stack);
                    self.emitter.emit ('error', err);
                });
            }, function (err) {
                console.log ('createAnswer error', err, err.stack);
                self.emitter.emit ('error', err);
            });
        }, function (err) {
            console.log ('setRemoteDescription error', err, err.stack);
            self.emitter.emit ('error', err);
        });
        return;
    }

    if (msg.ICE) {
        var ICE = JSON.parse (msg.ICE);
        if (
            !Object.hasOwnProperty.call (this.sockets, msg.from)
         || !this.sockets[msg.from].ready
        ) {
            if (Object.hasOwnProperty.call (this.iceBox, msg.from))
                this.iceBox[msg.from].push (ICE);
            else
                this.iceBox[msg.from] = [ ICE ];
            return;
        }
        if (ICE && Object.hasOwnProperty.call (this.sockets, msg.from)) try {
            this.sockets[msg.from].addIceCandidate (new ICECandidate (ICE));
        } catch (err) { /* weird, an invalid ICE candidate */ }
    }
};


/**     @member/Function emit
    Emit an event on every connected remote Peer instance.
@argument/String name
    The name of the event to emit remotely.
@args arguments
    An arbitrary number of JSON-serializable arguments may be passed to all remotes.
*/
Peer.prototype.emit = function(){
    var self = this;

    if (!arguments.length)
        return;
    var args = Array.prototype.slice.apply (arguments);
    args[0] = String (args[0]);

    if (!this.connected) {
        this.connect (function(){ self.emit.apply (self, arguments); });
        return;
    }

    var msg = JSON.stringify ({ event:args });
    for (var i=0,j=this.transmitChannels.length; i<j; i++)
        try {
            var channel = this.transmitChannels[i];
            if (channel.readyState != 'open') { // firefox won't throw an Error
                if (this.dropSocket (channel.socket)) {
                    i--; j--;
                }
                continue;
            }
            channel.send (msg);
        } catch (err) {
            if (this.dropSocket (channel.socket)) {
                i--; j--;
            }
        }
};


/**     @member/Function addStream
    Send a Stream to every connected remote Peer instance. Due to multiplexing, it is advisable not
    to consume streams naively [when receiving them](+stream).
@args/MediaStream|substation.MultimediaStream stream
*/
Peer.prototype.addStream = function(){
    if (!arguments.length)
        return;
    var self = this;

    // just push the new streams into this.outgoingStreams, if they're novel
    var doRenegotiate = false;
    for (var i=0,j=arguments.length; i<j; i++) {
        var stream = arguments[i];
        if (stream instanceof MultimediaStream)
            stream = stream.stream;
        if (this.outgoingStreams.indexOf (stream) < 0) {
            this.outgoingStreams.push (stream);
            doRenegotiate = true;
        }
    }

    if (doRenegotiate)
        this.renegotiate();
};

/**     @member/Function removeStream
    Remove any number of streams from every connected remote Peer instance.
@args/MediaStream|substation.MultimediaStream streams
*/
Peer.prototype.removeStream = function(){
    if (!arguments.length)
        return;
    var self = this;

    var indexes = [];
    var doRemove = [];
    for (var i=0,j=arguments.length; i<j; i++) {
        var stream = arguments[i];
        if (stream instanceof MultimediaStream)
            stream = stream.stream;
        var index = self.outgoingStreams.indexOf (stream);
        if (index >= 0) {
            indexes.push (index);
            doRemove.push (stream);
        }
    }
    indexes.sort();
    if (!indexes.length)
        return;

    for (var i=indexes.length-1; i>=0; i--)
        self.outgoingStreams.splice (indexes[i], 1);

    this.renegotiate (indexes);
};

Peer.prototype.addListener = function(){
    this.emitter.addListener.apply (this.emitter, arguments);
};
Peer.prototype.on = function(){
    this.emitter.on.apply (this.emitter, arguments);
};
Peer.prototype.once = function(){
    this.emitter.once.apply (this.emitter, arguments);
};
Peer.prototype.removeListener = function(){
    this.emitter.removeListener.apply (this.emitter, arguments);
};
Peer.prototype.removeAllListeners = function(){
    this.emitter.removeAllListeners.apply (this.emitter, arguments);
};
Peer.prototype.setMaxListeners = function(){
    this.emitter.setMaxListeners.apply (this.emitter, arguments);
};
Peer.prototype.listeners = function(){
    this.emitter.listeners.apply (this.emitter, arguments);
};


module.exports = Peer;
