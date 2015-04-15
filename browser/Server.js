
var http = require ('http-browserify');
var buffer = require ('buffer');
var url = require ('url');
var socketio = require ('socket.io-client');
var Alice = require ('./Alice');
var Bob = require ('./Bob');
var inherit = require ('./inherit');
var EventEmitter = require ('events').EventEmitter;


/**     @class substation.Server
    @root

@member/substation station
@member/url host
@member/Boolean live
@member/Boolean liveSocketReady
@member/Object[substation.Peer] peers
@member/Number nextActionID
@member/Number actionTimeout
    @default `3000`
@member/Object[Function] actionCallbacks
*/
function Server (station, host) {
    EventEmitter.call (this);

    this.station = station;
    this.host = host;

    this.live = false;
    this.peers = [];
    this.peerIDs = {};
    this.peerIDCallbacks = {};
    this.peerTokens = {};
    this.nextActionID = 1;
    this.actionCallbacks = {};
    this.actionTimeout = 3000;
}
inherit (Server, EventEmitter);


/**     @member/Function goLive

*/
Server.prototype.goLive = function (callback) {
    if (this.live) {
        if (callback)
            if (this.liveSocketReady)
                process.nextTick (callback);
            else
                (this.liveCallbacks || (this.liveCallbacks = [])).push (callback);
        return;
    }
    this.live = true;

    this.liveSocket = socketio (this.host.origin);

    var self = this;
    this.liveSocket.on ('connect', function(){
        self.liveSocketReady = true;
        if (self.liveCallbacks) {
            for (var i=0,j=self.liveCallbacks.length; i<j; i++)
                process.nextTick (self.liveCallbacks[i]);
            delete self.liveCallbacks;
        }

        self.liveSocket.on ('reply', function (pack) {
            if (pack.events)
                self.station.sendEvents (pack.events);
            if (pack._id && Object.hasOwnProperty.call (self.actionCallbacks, pack._id)) {
                self.actionCallbacks[pack._id] (undefined, pack.status, pack.body || {});
                delete self.actionCallbacks[pack._id];
            }
        });

        self.liveSocket.on ('event', function (info) {
            self.station.sendEvents (self, [ info ]);
        });

        self.liveSocket.on ('peer', function (info) {
            if (info._id && Object.hasOwnProperty.call (self.peerIDs, String (info._id))) {
                // matching peer
                if (info.token)
                    self.peerTokens[info.token] = peer;
                self.peerIDs[info._id].processPeerMessage (info);
                return;
            }
            if (info.token && Object.hasOwnProperty.call (self.peerTokens, info.token)) {
                self.peerTokens[info.token].processPeerMessage (info);
                return;
            }

            if (!info.init)
                return; // caught an echo intended for a sibling connection

            // a new peer is connecting to us!
            var peer = new Bob (self, info.peer, info.token, info.sdp, info.ICE);
            self.peers.push (peer);
            self.peerTokens[info.token] = peer;
        });

        self.emit ('live', true);
    });

    this.liveSocket.on ('error', function (err) {
        console.log ('Live Socket Error', err);
    });

    this.liveSocket.on ('disconnect', function(){
        self.liveSocketReady = false;
        self.emit ('live', false);
    });

    // content events
    this.liveSocket.on ('reply', function (info) {
        if (info.events)
            for (var i=0,j=info.events.length; i<j; i++)
                self.station.emit.apply (self.station, info.events[i]);
    });
}


/**     @member/Function getPeer

@argument/Object credentials
    To request a peer connection, you must pass a "credential document" to a handler on the server.
    This document is used to select the peer, and the handler makes the ultimate decision on whether
    the connection is allowed to proceed.

    WebRTC and the `Peer` class are **not** suitable for large numbers of connections.
@callback
    @argument/Error|undefined err
    @argument/substation.Peer connectedPeer
*/
function deepEqual (first, second) {
    if (first === second) return true;
    var type = Object.typeStr (first);
    if (type != Object.typeStr (second)) return false;
    if (type == 'object' || type == 'array') {
        if (Object.keys (first).length != Object.keys (second).length) return false;
        for (var key in first)
            if (!Object.deepEqual (first[key], second[key])) return false;
        return true;
    }
    return first == second;
}
Server.prototype.getPeer = function (credentials, callback) {
    var peer;

    if (this.peers) for (var i=0,j=this.peers.length; i<j; i++)
        if (deepEqual (this.peers[i].credentials, credentials)) {
            peer = this.peers[i];
            break;
        }
    if (!peer) {
        peer = new Alice (this, credentials);
        this.peers.push (peer);
    }

    return peer;
}


/**     @local/Function formToRequest
    Serialize a `<form>` to its `application/x-www-form-urlencoded` representation.

    Borrowed from [here](https://code.google.com/p/form-serialize/).
*/
function formToRequest (form) {
    var items = [];
    for (var i = form.elements.length - 1; i >= 0; i--) {
        if (form.elements[i].name === "") {
            continue;
        }
        switch (form.elements[i].nodeName) {
        case 'INPUT':
            switch (form.elements[i].type) {
            case 'text':
            case 'hidden':
            case 'password':
            case 'button':
            case 'reset':
            case 'submit':
                items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].value));
                break;
            case 'checkbox':
            case 'radio':
                if (form.elements[i].checked) {
                    items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].value));
                }
                break;
            case 'file':
                break;
            }
            break;
        case 'TEXTAREA':
            items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].value));
            break;
        case 'SELECT':
            switch (form.elements[i].type) {
            case 'select-one':
                items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].value));
                break;
            case 'select-multiple':
                for (var j = form.elements[i].options.length - 1; j >= 0; j--) {
                    if (form.elements[i].options[j].selected) {
                        items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].options[j].value));
                    }
                }
                break;
            }
            break;
        case 'BUTTON':
            switch (form.elements[i].type) {
            case 'reset':
            case 'submit':
            case 'button':
                items.push(form.elements[i].name + "=" + encodeURIComponent(form.elements[i].value));
                break;
            }
            break;
        }
    }

    return items.join("&");
}


/**     @local/Function formToJSON
    Serialize a `<form>` to its `application/json` representation.

    Borrowed from [here](https://code.google.com/p/form-serialize/) and tweaked.
*/
function formToJSON (form) {
    var doc = {};
    for (var i = form.elements.length - 1; i >= 0; i--) {
        if (form.elements[i].name === "") {
            continue;
        }
        switch (form.elements[i].nodeName) {
        case 'INPUT':
            switch (form.elements[i].type) {
            case 'text':
            case 'hidden':
            case 'password':
            case 'button':
            case 'reset':
            case 'submit':
                doc[form.elements[i].name] = form.elements[i].value;
                break;
            case 'checkbox':
            case 'radio':
                if (form.elements[i].checked) {
                    doc[form.elements[i].name] = form.elements[i].value;
                }
                break;
            case 'file':
                break;
            }
            break;
        case 'TEXTAREA':
            doc[form.elements[i].name] = form.elements[i].value;
            break;
        case 'SELECT':
            switch (form.elements[i].type) {
            case 'select-one':
                doc[form.elements[i].name] = form.elements[i].value;
                break;
            case 'select-multiple':
                for (var j = form.elements[i].options.length - 1; j >= 0; j--) {
                    if (form.elements[i].options[j].selected) {
                        doc[form.elements[i].name] = form.elements[i].options[j].value;
                    }
                }
                break;
            }
            break;
        case 'BUTTON':
            switch (form.elements[i].type) {
            case 'reset':
            case 'submit':
            case 'button':
                doc[form.elements[i].name] = form.elements[i].value;
                break;
            }
            break;
        }
    }
    return doc;
}


/**     @member/Function action
    Perform an action over the best transport available right now.

    When four arguments are provided, they are assumed to be either `(method, path, body, callback)`
    or `(method, path, query, body)`.
@argument/String method
    @optional
@argument/String path
@argument/Object query
    @optional
    GET parameters for the request.
@argument/Object|Array|String|Element body
    @optional
    An Object or Array will be sent as JSON. A `<form>` Element is serialized as
    `application/x-www-form-urlencoded`. Any other Element is serialized as html.
@callback
    @optional
    @argument/Error|undefined err
        Any network or configuration-related errors will be reported here.
    @argument/Number status
        Http response code for the action.
    @argument/Object|undefined content
        If the server action passes `content` through the reply, it arrives here.
    @returns
@returns/substation.Server
    Self.
*/
Server.prototype.action = function (/* method, path, query, body, callback */) {
    var method, path, query, body, callback;
    switch (arguments.length) {
        case 1:
            path = arguments[0];
            break;
        case 2:
            // ( path, callback)
            // ( method, path )
            // ( path, query )
            var lastType = typeof arguments[1];
            if (lastType == 'string') {
                method = arguments[0];
                path = arguments[1];
            } else {
                path = arguments[0];
                if (lastType == 'object')
                    query = arguments[1];
                else
                    callback = arguments[1];
            }
            break;
        case 3:
            // ( path, body, callback )
            // ( method, path, callback )
            // ( method, path, body )
            if (typeof arguments[1] == 'object') {
                path = arguments[0];
                body = arguments[1];
                callback = arguments[2];
            } else {
                method = arguments[0];
                if (typeof arguments[2] == 'function')
                    callback = arguments[2];
                else
                    body = arguments[2];
            }
            break;
        case 4:
            // ( method, path, query, body )
            // ( method, path, body, callback )
            method = arguments[0];
            path = arguments[1];
            if (typeof arguments[3] == 'function') {
                body = arguments[2];
                callback = arguments[3];
            } else {
                query = arguments[2];
                body = arguments[3];
            }
            break;
        default:
            method = arguments[0];
            path = arguments[1];
            query = arguments[2];
            body = arguments[3];
            callback = arguments[4];
    }


    if (this.liveSocketReady) {
        // make a live transaction
        var action = {
            method:     method || 'GET',
            path:       path
        };
        if (query)
            action.query = query;
        if (body) {
            if (body instanceof window.Element) {
                if (body.nodeName.toUpperCase() == 'FORM')
                    body = formToJSON (body);
                else
                    body = body.outerHTML;
            }
            action.body = body;
        }
        if (callback) {
            var id = this.nextActionID++;
            action._id = id;
            var timer, timedOut = false;
            this.actionCallbacks[id] = function(){
                if (timedOut) return;
                clearTimeout (timer);
                callback.apply (this, arguments);
            };
            timer = setTimeout (function(){
                timedOut = true;
                callback (new Error ('action timed out'));
            }, this.actionTimeout);
        }
        this.liveSocket.emit ('action', action);
        return this;
    }

    // make a REST transaction
    if (this.domestic)
        (query || (query = {}))._domestic = this.domestic;
    var fullpath = path;
    if (query) {
        var querystr;
        var keys = Object.keys (query);
        var convertedKeys = keys.map (function (item) { return encodeURIComponent (item); });
        var items = [];
        for (var i=0,j=keys.length; i<j; i++)
            items.push (convertedKeys[i]+'='+encodeURIComponent (query[keys[i]]));
        querystr = '?'+items.join ('&');
        fullpath += querystr;
    }

    var headers = { accept:'application/json' };
    if (body)
        if (typeof body == 'object')
            if (body instanceof window.Element)
                if (body.nodeName.toUpperCase() == 'FORM') {
                    body = formToRequest (body);
                    headers['content-type'] = 'application/x-www-form-urlencoded';
                } else {
                    body = body.outerHTML;
                    headers['content-type'] = 'text/html';
                }
            else {
                body = JSON.stringify (body);
                headers['content-type'] = 'application/json';
            }
        else
            headers['content-type'] = 'text/plain';

    var opts = {
        host:           this.host.host,
        protocol:       this.host.protocol,
        path:           fullpath,
        headers:        headers
    };
    if (method)
        opts.method = method;

    var self = this;
    var startTime = (new Date()).getTime();
    var timeout = this.actionTimeout;
    var timer, timedOut = false;
    var request = http.request (opts, function (response) {
        var docstr = '';
        response.on ('data', function (chunk) {
            if (timedOut) return;
            docstr += chunk;
        });
        response.on ('end', function(){
            if (timedOut) return;
            clearTimeout (timer);
            var responseDoc;
            try {
                responseDoc = JSON.parse (docstr);
            } catch (err) {
                if (callback)
                    callback (new Error ('invalid response document'), response.statusCode);
                return;
            }
            if (responseDoc.events)
                self.station.sendEvents (responseDoc.events);
            if (callback)
                callback (undefined, response.statusCode, responseDoc.content || {});
        });
    });


    if (callback) {
        timer = setTimeout (function(){
            timedOut = true;
            callback (new Error ('action timed out'));
        }, this.actionTimeout);

        request.on ('error', function (err) {
            if (timedOut) return;
            callback (err);
        });
    }

    if (body)
        request.write (body);
    request.end();
}


/**     @member/Function connectPeer

*/
Server.prototype.connectPeer = function (credentials, offer, peer) {
    var peerTransactionID = this.nextActionID++;
    this.peerIDs[peerTransactionID] = peer;
    this.liveSocket.emit ('peer', {
        _id:    peerTransactionID,
        peer:   credentials,
        sdp:    offer
    });
};


/**     @member/Function sendPeerMessage

*/
Server.prototype.sendPeerMessage = function (msg) {
    this.liveSocket.emit ('peer', msg);
};


/**     @class Peer

@member/Function on
@member/Function emit
@member/Function disconnect
@member/Function addStream
@member/Array streams
*/


module.exports = Server;
