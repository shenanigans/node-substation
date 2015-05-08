
var EventEmitter = require ('events').EventEmitter;

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


/**     @class substation.Server.Peer.Peer
    @parent substation.Server.Peer
    @root
@event connect
@argument/substation.Server server
@argument/Object query
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
    this.incomingStreams = [];

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

*/
Peer.prototype.assimilateSocket = function (socket, SID) {
    var self = this;
    this.liveSockets++;
    this.sockets[SID] = socket;
    socket.SID = SID;

    var transmitChannel = socket.createDataChannel ('transmit', { reliable:true });
    transmitChannel.socket = socket;
    socket.transmitChannel = transmitChannel;
    var transmitChannels = this.transmitChannels;

    for (var i=0,j=self.outgoingStreams.length; i<j; i++)
        socket.addStream (self.outgoingStreams[i]);

    transmitChannel.onopen = function (event) {
        if (transmitChannel.readyState != 'open') return;
        console.log ('check for redundant channels, among '+transmitChannels.length);
        for (var i=0,j=transmitChannels.length; i<j; i++)
            if (transmitChannels[i].socket.SID == socket.SID) {
                console.log ('close redundant channel');
                transmitChannels[i].close();
                transmitChannels.splice (i, 1);
                i--; j--;
            }
        socket.connected = true;
        transmitChannels.push (transmitChannel);
        if (!self.connected) {
            self.connecting = false;
            self.connected = true;
            if (socket.iceQueue) {
                for (var i=0,j=socket.iceQueue.length; i<j; i++)
                    transmitChannel.send (JSON.stringify ({ ICE:iceQueue[i] }));
                delete socket.iceQueue;
            }
            self.emitter.emit ('connect');
            self.emitter.emit ('socketConnect', SID);
            self.server.emit ('peer', self);
            if (self.connectionQueue) {
                for (var i=0,j=self.connectionQueue.length; i<j; i++)
                    self.connectionQueue[i]();
                delete self.connectionQueue;
            }
        }
    };

    socket.onicecandidate = function (event) {
        if (!event.candidate)
            return;

        console.log ('ice candidate');
        if (socket.iceQueue) {
            socket.iceQueue.push (event.candidate);
            return;
        }

        if (socket.connected) {
            socket.transmitChannel.send (JSON.stringify ({ ICE:event.candidate }));
            return;
        }

        self.server.sendPeerMessage (
            { token:self.token, ICE:JSON.stringify (event.candidate), to:SID }
        );
    };

    socket.ondatachannel = function (event) {
        var channel = event.channel;
        channel.onmessage = function (event) {
            var msg = JSON.parse (event.data);
            if (msg.event)
                self.emitter.emit.apply (self.emitter, msg.event);
            if (msg.ICE)
                if (socket.ready)
                    socket.addIceCandidate (new ICECandidate (msg.ICE));
                else if (Object.hasOwnProperty.call (self.iceBox, socket.SID))
                    self.iceBox[socket.SID].push (msg.ICE);
                else
                    self.iceBox[socket.SID] = [ msg.ICE ];
            if (!msg.sdp)
                return;
            if (msg.sdp.type == 'answer') {
                if (!Object.hasOwnProperty.call (self.sockets, socket.SID))
                    return;
                var updateSocket = self.sockets[socket.SID];
                updateSocket.setRemoteDescription (
                    new SessionDescription (msg.sdp),
                    function(){
                        if (updateSocket.iceQueue) {
                            for (var i=0,j=updateSocket.iceQueue.length; i<j; i++)
                                self.server.sendPeerMessage ({
                                    ICE:    JSON.stringify (updateSocket.iceQueue[i]),
                                    to:     socket.SID,
                                    token:  self.token
                                });
                            delete updateSocket.iceQueue;
                        }
                        updateSocket.ready = true;
                        if (Object.hasOwnProperty.call (self.iceBox, socket.SID)) {
                            var tray = self.iceBox[socket.SID];
                            for (var i=0,j=tray.length; i<j; i++)
                                updateSocket.addIceCandidate (new ICECandidate (tray[i]));
                            delete self.iceBox[socket.SID];
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
                var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
                self.assimilateSocket (newSocket, socket.SID);
                self.emitter.on ('socketConnect', function dropSocket (openSID) {
                    if (openSID != socket.SID)
                        return;
                    socket.close();
                    self.emitter.removeListener ('socketConnect', dropSocket);
                });
                newSocket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                    newSocket.createAnswer (function (answer) {
                        newSocket.setLocalDescription (new SessionDescription (answer), function(){
                            newSocket.ready = true;
                            if (Object.hasOwnProperty.call (self.iceBox, socket.SID)) {
                                var tray = self.iceBox[socket.SID];
                                for (var i=0,j=tray.length; i<j; i++)
                                    socket.addIceCandidate (new ICECandidate (tray[i]));
                                delete self.iceBox[socket.SID];
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

            socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                socket.createAnswer (function (answer) {
                    socket.setLocalDescription (answer, function(){
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
        self.incomingStreams.push (stream);
        self.emitter.emit ('stream', stream);
    }
};


/**     @member/Function dropSocket

*/
Peer.prototype.dropSocket = function (socket) {
    socket.close();
    for (var i=0,j=this.transmitChannels.length; i<j; i++)
        if (this.transmitChannels[i].socket === socket) {
            this.transmitChannels.splice (i, 1);
            break;
        }
    if (!Object.hasOwnProperty.call (this.sockets, socket.SID))
        return;
    delete this.sockets[socket.SID];
    this.liveSockets = Math.max (0, this.liveSockets - 1);

    if (this.liveSockets) return;

    if (!this.connected)
        this.emitter.emit ('error', new Error ('connection failed'));
    this.connected = false;
    this.connecting = false;

    this.emitter.emit ('close');
    this.server.emit ('peerDisconnect', this);
};


/**     @member/Function connect

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

*/
Peer.prototype.processPeerMessage = function (msg) {
    if (msg.token)
        this.token = msg.token;
    if (!msg.from)
        return;

    var socket;
    var self = this;

    if (msg.sdp) {
        if (Object.hasOwnProperty.call (this.sockets, msg.from))
            socket = this.sockets[msg.from];
        else {
            socket = new PeerConnection ({ iceServers:self.server.iceServers });
            this.assimilateSocket (socket, msg.from);
        }

        if (msg.sdp.type == 'answer') {
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
            if (Object.hasOwnProperty.call (this.iceBox, msg.from))
                this.iceBox[msg.from].push (ICE);
            else
                this.iceBox[msg.from] = [ ICE ];
            return;
        }
        if (ICE && Object.hasOwnProperty.call (this.sockets, msg.from)) try {
            this.sockets[msg.from].addIceCandidate (new ICECandidate (ICE));
        } catch (err) {
            console.log ('invalid ICE candidate received', err);
            if (!this.connected)
                this.emitter.emit ('error', err);
        }
        return;
    }

    // init
    if (msg.init && !Object.hasOwnProperty.call (this.sockets, msg.from)) {
        var socket = new PeerConnection({ iceServers:this.server.iceServers });
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
};


/**     @member/Function emit
    Emit an event from the remote `Peer` Object.
*/
Peer.prototype.emit = function(){
    var self = this;

    if (!this.connected) {
        this.connect (function(){ self.emit.apply (self, arguments); });
        return;
    }

    var msg = JSON.stringify ({ event:Array.prototype.slice.apply (arguments) });
    for (var i=0,j=this.transmitChannels.length; i<j; i++)
        try {
            this.transmitChannels[i].send (msg);
        } catch (err) {
            this.dropSocket (this.transmitChannels[i].socket);
        }
};


/**     @member/Function addStream
    Send a Stream to every connected Peer instance.
*/
Peer.prototype.addStream = function (stream) {
    var self = this;
    this.outgoingStreams.push (stream);
    for (var sid in this.sockets)
        if (this.sockets[sid].connected) {
            var socket = this.sockets[sid];
            socket.ready = false;
            if (!socket.createdOffer) {
                var newSocket = new PeerConnection({ iceServers:self.server.iceServers });
                self.assimilateSocket (newSocket, socket.SID);
                self.emitter.on ('socketConnect', function dropSocket (openSID) {
                    if (openSID != socket.SID) return;
                    socket.close();
                    self.emitter.removeListener ('socketConnect', dropSocket);
                });
                newSocket.iceQueue = [];
                newSocket.createOffer (function (offer) {
                    newSocket.setLocalDescription (offer, function(){
                        socket.transmitChannel.send (JSON.stringify ({ sdp:offer }));
                    }, function (err) {
                        console.log ('reengage setLocalDescription error', err);
                    });
                }, function (err) {
                    console.log ('reengage createOffer error', err);
                });
                continue;
            }

            socket.addStream (stream);
            socket.createOffer (function (offer) {
                socket.setLocalDescription (offer, function(){
                    socket.transmitChannel.send (JSON.stringify ({ sdp:offer }));
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
