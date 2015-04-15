
var EventEmitter = require ('events').EventEmitter;
var inherit = require ('./inherit');

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

var WebRTC_ICE = [
    { url:'stun:stun.l.google.com:19302' },
    { url:'stun:stun1.l.google.com:19302' },
    { url:'stun:stun2.l.google.com:19302' },
    { url:'stun:stun3.l.google.com:19302' },
    { url:'stun:stun4.l.google.com:19302' },
    { url:'stun:stun.ucsb.edu:3478' },
    { url:'stun:stun.services.mozilla.com:3478' }
];


/**     @class substation.Server.Peer.Alice
    @parent substation.Server.Peer
    @root
    An outgoing peer connection created from this end. Alice is very complicated because Bob may
    respond to her SDP offer from any number of connections. She activates a DataChannel on each
    connection and stores it. Events are broadcast to all connections and incoming events are
    aggregated from all connections.

    Alice does not connect automagically. Call [connect](#connect) with an optional callback, or
    listen for the [`connect` event](!connect)
@event connect
*/
function Alice (server, credentials) {
    this.server = server;
    this.credentials = credentials;

    this.connected = false;
    this.connecting = false;
    this.connectionQueue = [];
    this.isAlice = true;

    this.sockets = [];
    this.transmitChannels = [];
    this.emitter = new EventEmitter();
}


/**     @member/Function connect

*/
Alice.prototype.connect = function (callback) {
    if (this.connected) {
        process.nextTick (callback);
        return;
    }
    if (callback)
        this.connectionQueue.push (callback);
    if (this.connecting)
        return;
    this.connecting = true;

    var self = this;
    this.server.goLive (function (err) {
        if (err) return callback (err);
        var socket = new PeerConnection ({
            iceServers:     WebRTC_ICE
        });
        self.assimilateSocket (socket);

        socket.createOffer (function (offer) {
            self.outgoingOffer = offer;
            socket.setLocalDescription (new SessionDescription (offer), function(){
                self.server.connectPeer (self.credentials, offer.sdp, self);
            }, callback);
        }, callback);
    });
};


/**     @member/Function processPeerMessage

*/
Alice.prototype.processPeerMessage = function (msg) {
    if (msg.token) {
        if (!this.token) {
            // unblock ICE
            this.token = msg.token;
            if (this.pendingICE) {
                for (var i=0,j=this.pendingICE.length; i<j; i++)
                    this.server.sendPeerMessage ({ token:msg.token, ICE:this.pendingICE[i] });
                delete this.pendingICE;
            }
            this.sockets[0].setRemoteDescription (new SessionDescription (JSON.parse (msg.sdp)));
            return;
        }
        this.token = msg.token;
    }
    if (msg.sdp) {
        var socket = new PeerConnection ({
            iceServers:     WebRTC_ICE
        });
        var self = this;
        socket.setLocalDescription (new SessionDescription (this.outgoingOffer), function(){
            socket.setRemoteDescription (new SessionDescription (msg.sdp), function(){
                self.assimilateSocket (socket);
            }, function (err) {
                console.log ('setRemoteDescription error', err, err.stack);
            });
        }, function (err) {
            console.log ('setLocalDescription error', err, err.stack);
        });
    }
    if (msg.ICE) {
        var ICE = JSON.parse (msg.ICE);
        if (ICE) for (var i=0,j=this.sockets.length; i<j; i++)
            this.sockets[i].addIceCandidate (new ICECandidate (ICE));
    }
};


/**     @member/Function assimilateSocket
    @development

*/
Alice.prototype.assimilateSocket = function (socket) {
    var self = this;
    socket.onicecandidate = function (event) {
        if (!event.candidate) {
            // ICE failed

            return;
        }

        var ICE = JSON.stringify (event.candidate);
        if (!self.token) {
            (self.pendingICE || (self.pendingICE = [])).push (ICE);
            return;
        }
        self.server.sendPeerMessage ({ token:self.token, ICE:ICE });
    };

    socket.onaddstream = function (event) {
        var stream = event.stream;
        self.streams.push (stream);
        self.emitter.emit ('stream', stream);
    };

    socket.ondatachannel = function (event) {
        var channel = event.channel;
        channel.onmessage = function (event) {
            self.emitter.emit.apply (self, JSON.parse (event.data));
        };

        // connected when first channel arrives
        self.connecting = false;
        if (self.connected) return;
        self.connected = true;
        for (var i=0,j=self.connectionQueue.length; i<j; i++)
            self.connectionQueue[i]();
        delete self.connectionQueue;
        self.emitter.emit ('connected');
        self.server.emit ('outgoingPeer', self);
        self.server.emit ('peer', self);
    };
    self.sockets.push (socket);
    self.transmitChannels.push (socket.createDataChannel ("transmit", { reliable:false }));
};


/**     @member/Function emit
    Emit an event from the remote `Peer` Object.
*/
Alice.prototype.emit = function(){
    var self = this;

    if (!this.connected) {
        this.connect (function(){ self.emit.apply (self, arguments); });
        return;
    }

    var msg = JSON.stringify (Array.prototype.slice.apply (arguments));
    for (var i=0,j=this.transmitChannels.length; i<j; i++)
        this.transmitChannels[i].send (msg);
};


Alice.prototype.addListener = function(){
    this.emitter.addListener.apply (this.emitter, aruments);
};
Alice.prototype.on = function(){
    this.emitter.on.apply (this.emitter, aruments);
};
Alice.prototype.once = function(){
    this.emitter.once.apply (this.emitter, aruments);
};
Alice.prototype.removeListener = function(){
    this.emitter.removeListener.apply (this.emitter, aruments);
};
Alice.prototype.removeAllListeners = function(){
    this.emitter.removeAllListeners.apply (this.emitter, aruments);
};
Alice.prototype.setMaxListeners = function(){
    this.emitter.setMaxListeners.apply (this.emitter, aruments);
};
Alice.prototype.listeners = function(){
    this.emitter.listeners.apply (this.emitter, aruments);
};


module.exports = Alice;
