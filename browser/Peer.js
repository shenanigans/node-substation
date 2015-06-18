
var EventEmitter = require ('events').EventEmitter;
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

    Do not attempt to instantiate a Peer directly, just get one from [a Server instance.]
    (substation.Server#getPeer) As a note to future archeologists: `dropSocket` has to be duplicated
    all over the place because of Firefox bugs.
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
                    // release ICE
                    socket.ready = true;
                    if (Object.hasOwnProperty.call (self.iceBox, msg.from)) {
                        var iceBox = self.iceBox[msg.from];
                        for (var i=0,j=iceBox.length; i<j; i++)
                            socket.addIceCandidate (new ICECandidate (iceBox[i]));
                        delete self.iceBox[msg.from];
                    }
                    if (socket.queue) window.setTimeout (function(){
                        for (var i=0,j=socket.queue.length; i<j; i++)
                            self.server.sendPeerMessage (
                                { token:msg.token, ICE:JSON.stringify (socket.queue[i]), to:SID }
                            );
                        delete socket.queue;
                    }, 500);
                    server.sendPeerMessage ({ token:msg.token, to:msg.from, sdp:answer });
                    socket.ready = true;
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
        socket.createdOffer = true;
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
Peer.prototype.assimilateSocket = function (socket, SID) {
    var self = this;
    var transmitChannels = this.transmitChannels;
    if (!Object.hasOwnProperty.call (this.sockets, SID))
        this.liveSockets++;
    else
        socket.delegate = this.sockets[SID];
    this.sockets[SID] = socket;
    socket.SID = SID;

    var transmitChannel = socket.createDataChannel ('transmit', { reliable:true });
    transmitChannel.socket = socket;
    socket.transmitChannel = transmitChannel;

    for (var i=0,j=self.outgoingStreams.length; i<j; i++)
        socket.addStream (self.outgoingStreams[i]);

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

        // do we have streams?
        if (!self.outgoingStreams.length)
            return;

        // add new outgoing streams
        // firefox chose to release without getStreamById so it's effectively not part of the api
        // we can't count on it to be there
        var mustRenegotiate = false;
        var streams = socket.getLocalStreams();
        var ids = {};
        for (var i=0,j=streams.length; i<j; i++)
            ids[streams[i].id] = true;
        for (var i=0,j=self.outgoingStreams.length; i<j; i++)
            if (!Object.hasOwnProperty.call (ids, self.outgoingStreams[i].id)) {
                socket.addStream (self.outgoingStreams[i]);
                mustRenegotiate = true;
            }
        if (!mustRenegotiate)
            return;

        // renegotiate
        socket.ready = false;
        if (!socket.createdOffer) {
            console.log ('post-startup: initiate reverse renegotiation');
            var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
            self.assimilateSocket (newSocket, socket.SID);
            self.emitter.on ('socketConnect', function dropSocket (openSID) {
                if (openSID != socket.SID) return;
                console.log ('tripped close 3');
                socket.close();
                self.emitter.removeListener ('socketConnect', dropSocket);
            });
            // newSocket.iceQueue = [];
            newSocket.createOffer (function (offer) {
                newSocket.setLocalDescription (offer, function(){
                    socket.transmitChannel.send (JSON.stringify ({ sdp:offer }));
                }, function (err) {
                    console.log ('reengage setLocalDescription error', err);
                });
            }, function (err) {
                console.log ('reengage createOffer error', err);
            });
            return;
        }

        console.log ('post-startup: initiate forward renegotiation');
        socket.createOffer (function (offer) {
            socket.setLocalDescription (offer, function(){
                socket.transmitChannel.send (JSON.stringify ({ sdp:offer }));
            }, function (err) {
                console.log ('renegotiation setLocalDescription error', err);
            });
        }, function (err) {
            console.log ("renegotiation createOffer error", err);
        });
    };


    socket.onicecandidate = function (event) {
        if (!event.candidate)
            return;

        if (socket.delegate && socket.delegate.connected) {
            console.log ('sent ICE by socket');
            socket.delegate.transmitChannel.send (JSON.stringify ({ ICE:event.candidate }));
            return;
        }

        console.log ('sent ICE by server');
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
            var updateSocket = self.sockets[SID];
            if (msg.event)
                self.emitter.emit.apply (self.emitter, msg.event);
            if (msg.ICE) {
                if (updateSocket.ready) {
                    console.log ('using ICE from socket');
                    updateSocket.addIceCandidate (new ICECandidate (msg.ICE));
                } else {
                    console.log ('storing ICE from socket');
                     if (Object.hasOwnProperty.call (self.iceBox, SID))
                        self.iceBox[SID].push (msg.ICE);
                    else
                        self.iceBox[SID] = [ msg.ICE ];
                }
            }
            if (!msg.sdp)
                return;

            if (msg.sdp.type == 'answer') {
                if (!Object.hasOwnProperty.call (self.sockets, SID))
                    return;
                console.log ('renegotiation answer');
                updateSocket.setRemoteDescription (
                    new SessionDescription (msg.sdp),
                    function(){
                        console.log ('release ICE');
                        updateSocket.ready = true;
                        if (Object.hasOwnProperty.call (self.iceBox, SID)) {
                            var tray = self.iceBox[SID];
                            for (var i=0,j=tray.length; i<j; i++)
                                updateSocket.addIceCandidate (new ICECandidate (tray[i]));
                            delete self.iceBox[SID];
                        }
                    },
                    function (err) {
                        console.log ('renegotiation remote answer setRemoteDescription error', err);
                    }
                );
                return;
            }

            socket.ready = false;
            if (socket.createdOffer) {
                console.log ('accept reverse renegotiation request');
                // accepting reverse renegotiation request
                var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
                self.assimilateSocket (newSocket, SID);
                self.emitter.on ('socketConnect', function dropSocket (openSID) {
                    if (openSID != socket.SID)
                        return;
                    console.log ('tripped close 1');
                    socket.close();
                    self.emitter.removeListener ('socketConnect', dropSocket);
                });
                newSocket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                    console.log ('creating answer');
                    newSocket.createAnswer (function (answer) {
                        console.log ('setting local description');
                        newSocket.setLocalDescription (new SessionDescription (answer), function(){
                            console.log ('releasing ICE');
                            newSocket.ready = true;
                            if (Object.hasOwnProperty.call (self.iceBox, SID)) {
                                var tray = self.iceBox[SID];
                                for (var i=0,j=tray.length; i<j; i++)
                                    newSocket.addIceCandidate (new ICECandidate (tray[i]));
                                delete self.iceBox[SID];
                            }
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
                return;
            }

            console.log ('accept forward renegotiation request');
            // accepting forward renegotiation request
            socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                console.log ('creating answer');
                socket.createAnswer (function (answer) {
                    console.log ('setting local description');
                    socket.setLocalDescription (answer, function(){
                        console.log ('releasing ICE');
                        socket.ready = true;
                        if (Object.hasOwnProperty.call (self.iceBox, socket.SID)) {
                            var tray = self.iceBox[socket.SID];
                            for (var i=0,j=tray.length; i<j; i++)
                                socket.addIceCandidate (new ICECandidate (tray[i]));
                            delete self.iceBox[socket.SID];
                        }
                        transmitChannel.send (JSON.stringify ({ sdp:answer }));
                    }, function (err) {
                        console.log ('renegotiation setLocalDescription error', err);
                    });
                }, function (err) {
                    console.log ('renegotiation createAnswer error', err);
                });
            }, function (err) {
                console.log ('renegotiation setRemoteDescription error', err);
            });
        };

        // connected when channel is ready
        channel.onopen = function(event) {
            if (channel.readyState != 'open') return;
            socket.connected = true;
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
        console.log ('onaddstream', incomingStreams.length, index, stream);
        if (incomingStreams.length > index)
            incomingStreams[index].addReplacement (stream);
        else {
            var wrappedStream = new MultimediaStream (stream);
            incomingStreams.push (wrappedStream);
            self.emitter.emit ('stream', wrappedStream);
        }
    }

    function fatalError (event) {
        console.error ('fatal socket error', event);
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
        socket = new PeerConnection({ iceServers:this.server.iceServers });
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
            if (!Object.hasOwnProperty.call (this.sockets, msg.from)) {
                console.log ('received answer for unknown socket', msg.from);
                return;
            }
            socket = this.sockets[msg.from];
            socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                // release ICE
                socket.ready = true;
                if (Object.hasOwnProperty.call (self.iceBox, msg.from)) {
                    var iceBox = self.iceBox[msg.from];
                    for (var i=0,j=iceBox.length; i<j; i++)
                        socket.addIceCandidate (new ICECandidate (iceBox[i]));
                    delete self.iceBox[msg.from];
                }
            }, function (err) {
                console.log ('got incoming answer error', err);
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
                    self.server.sendPeerMessage ({ token:self.token, sdp:answer, to:msg.from });
                    // release ICE
                    socket.ready = true;
                    if (Object.hasOwnProperty.call (self.iceBox, msg.from)) {
                        var iceBox = self.iceBox[msg.from];
                        for (var i=0,j=iceBox.length; i<j; i++)
                            socket.addIceCandidate (new ICECandidate (iceBox[i]));
                        delete self.iceBox[msg.from];
                    }
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
            console.log ('storing ICE');
            if (Object.hasOwnProperty.call (this.iceBox, msg.from))
                this.iceBox[msg.from].push (ICE);
            else
                this.iceBox[msg.from] = [ ICE ];
            return;
        }
        if (ICE && Object.hasOwnProperty.call (this.sockets, msg.from)) try {
            console.log ('using ICE');
            this.sockets[msg.from].addIceCandidate (new ICECandidate (ICE));
        } catch (err) {
            console.log ('invalid ICE candidate received', err);
            if (!this.connected)
                this.emitter.emit ('error', err);
        }
        return;
    }
};


Peer.prototype.emit = function(){
    var self = this;

    if (!this.connected) {
        this.connect (function(){ self.emit.apply (self, arguments); });
        return;
    }

    var msg = JSON.stringify ({ event:Array.prototype.slice.apply (arguments) });
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
    to consume streams naively [when receiving them.](+stream)
@argument/MediaStream stream
*/
Peer.prototype.addStream = function (stream) {
    var self = this;
    if (stream instanceof MultimediaStream)
        stream = stream.stream;
    this.outgoingStreams.push (stream);
    for (var sid in this.sockets) {
        if (!this.sockets[sid].connected) {
            console.log ('socket not connected');
            continue;
        }

        var socket = this.sockets[sid];
        socket.ready = false;
        if (!socket.createdOffer) {
            // initiate reverse renegotiation
            console.log ('initiate reverse renegotiation');
            var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
            newSocket.createdOffer = true;
            self.assimilateSocket (newSocket, sid);
            self.emitter.on ('socketConnect', function dropSocket (openSID) {
                if (openSID != sid) return;
                console.log ('tripped close 2');
                socket.close();
                self.emitter.removeListener ('socketConnect', dropSocket);
            });
            // newSocket.iceQueue = [];
            console.log ('createOffer');
            newSocket.createOffer (function (offer) {
                console.log ('reverse offer');
                newSocket.setLocalDescription (offer, function(){
                    console.log ('reverse setLocalDescription');
                    socket.transmitChannel.send (JSON.stringify ({ sdp:offer }));
                }, function (err) {
                    console.log ('reengage setLocalDescription error', err);
                });
            }, function (err) {
                console.log ('reengage createOffer error', err);
            });
            continue;
        }

        // initiate forward renegotiation
        console.log ('initiate forward renegotiation');
        socket.addStream (stream);
        socket.createOffer (function (offer) {
            socket.setLocalDescription (offer, function(){
                socket.transmitChannel.send (JSON.stringify ({
                    sdp:        offer,
                    addStream:  [ stream.id ]
                }));
            }, function (err) {
                console.log ('renegotiation setLocalDescription error', err);
            });
        }, function (err) {
            console.log ("renegotiation createOffer error", err);
        });
    }
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
