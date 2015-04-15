
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


/**     @class substation.Server.Peer.Bob
    @parent substation.Server.Peer
    @root
    An incoming peer connection created from the far end. Bob is a simple socket relative to
    [Bob.](substation.Server.Peer.Bob) He is always instantiated with an existing SDP offer and
    automagically creates exactly one connection with a DataChannel.
*/
function Bob (server, credentials, token, sdp, ICE) {
    var self = this;
    this.server = server;
    this.credentials = credentials;
    this.token = token;
    this.incomingOffer = sdp;

    this.connecting = true;
    this.connectionQueue = [];
    this.emitter = new EventEmitter();

    var socket = this.socket = new PeerConnection({
        iceServers:     [
            { url:'stun:stun.l.google.com:19302' },
            { url:'stun:stun1.l.google.com:19302' },
            { url:'stun:stun2.l.google.com:19302' },
            { url:'stun:stun3.l.google.com:19302' },
            { url:'stun:stun4.l.google.com:19302' },
            { url:'stun:stun.ucsb.edu:3478' },
            { url:'stun:stun.services.mozilla.com:3478' }
        ]
    });
    this.transmitChannel = socket.createDataChannel ("transmit", { reliable:false });
    this.socket.setRemoteDescription (
        new SessionDescription ({ type:"offer", sdp:sdp }),
        function(){
            self.socket.createAnswer (function (answer) {
                socket.setLocalDescription (answer);
                self.outgoingAnswer = answer;
                server.sendPeerMessage ({ token:token, sdp:JSON.stringify (answer) });
            }, function (err) {
                // hmm
                console.log ('answer error', err);
            });
        },
        function (err) {
            // hmm
            console.log ('set remote error', err);
        }
    );

    socket.onicecandidate = function (event) {
        self.server.sendPeerMessage ({ token:self.token, ICE:JSON.stringify (event.candidate) });
    }

    socket.ondatachannel = function (event) {
        var channel = event.channel;
        channel.onmessage = function (event) {
            self.emitter.emit.apply (self, JSON.parse (event.data));
        };

        // connected when channel arrives
        self.connecting = false;
        if (self.connected) return;
        self.connected = true;
        for (var i=0,j=self.connectionQueue.length; i<j; i++)
            self.connectionQueue[i]();
        delete self.connectionQueue;
        self.emitter.emit ('connected');
        self.server.emit ('outgoingPeer', self);
        self.server.emit ('peer', self);
    }

    socket.onaddstream = function (event) {
        var stream = event.stream;
        self.streams.push (stream);
        self.emitter.emit ('stream', stream);
    }
}


/**     @member/Function emit
    Emit an event from the remote `Peer` Object.
*/
Bob.prototype.emit = function(){
    var self = this;

    if (!this.connected) {
        this.connect (function(){ self.emit.apply (self, arguments); });
        return;
    }

    this.transmitChannel.send (JSON.stringify (Array.prototype.slice.apply (arguments)));
};


/**     @member/Function processPeerMessage

*/
Bob.prototype.processPeerMessage = function (msg) {
    if (msg.ICE)
        this.socket.addIceCandidate (new ICECandidate (JSON.parse (msg.ICE)));
};


Bob.prototype.addListener = function(){
    this.emitter.addListener.apply (this.emitter, aruments);
};
Bob.prototype.on = function(){
    this.emitter.on.apply (this.emitter, aruments);
};
Bob.prototype.once = function(){
    this.emitter.once.apply (this.emitter, aruments);
};
Bob.prototype.removeListener = function(){
    this.emitter.removeListener.apply (this.emitter, aruments);
};
Bob.prototype.removeAllListeners = function(){
    this.emitter.removeAllListeners.apply (this.emitter, aruments);
};
Bob.prototype.setMaxListeners = function(){
    this.emitter.setMaxListeners.apply (this.emitter, aruments);
};
Bob.prototype.listeners = function(){
    this.emitter.listeners.apply (this.emitter, aruments);
};


module.exports = Bob;
