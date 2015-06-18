
var http = require ('http-browserify');
var buffer = require ('buffer');
var url = require ('url');
var socketio = require ('socket.io-client');
var Peer = require ('./Peer');
var inherit = require ('./inherit');
var EventEmitter = require ('events').EventEmitter;

function cookies(){
    this.keys = {};
    if (!window.document.cookie)
        return;
    var cfrags = window.document.cookie.split (';');
    for (var i=0,j=cfrags.length; i<j; i++) {
        var frags = cfrags[i].split ('=');
        this.keys[decodeURIComponent (frags[0])] = frags[1];
    }
}
cookies.prototype.get = function (key) {
    if (Object.hasOwnProperty.call (this.keys, key))
        return this.keys[key];
};

var WebRTC_ICE = [
    { url:'stun:stun.l.google.com:19302' },
    { url:'stun:stun1.l.google.com:19302' },
    { url:'stun:stun2.l.google.com:19302' },
    { url:'stun:stun3.l.google.com:19302' },
    { url:'stun:stun4.l.google.com:19302' },
    { url:'stun:stun.ucsb.edu:3478' },
    { url:'stun:stun.services.mozilla.com:3478' }
];

/**     @class substation.Server
    @root
    @super events.EventEmitter
    Represents a remote `substation` web domain service, expected to respond to remote URLs sharing
    a common hostname. Connections are manually upgraded to Socket.io with [#goLive]() or by
    requesting a [Peer connection](substation.Peer).
@argument/substation station
    The parent [substation]() instance is passed in.
@argument/URL host
    Any [URL]() containing the protocol and hostname of the desired remote service.
@argument/.Options options
    Additional configuration options for accessing this service.
@member/substation station
    The parent [substation]() instance.
@member/URL host
    A [URL]() containing the protocol and hostname of this service. No promises are made about path,
    query, and other parameters not required for selecting the service.
@member/Boolean live
@member/Boolean liveSocketReady
@member/Object[substation.Peer] peers
@member/Number nextActionID
@member/Number actionTimeout
    @default `3000`
@member/Object[Function] actionCallbacks
*/
function Server (station, host, options) {
    EventEmitter.call (this);
    options = options || {};
    this.station = station;
    this.host = host;
    this.isLive = false;
    this.peers = [];
    this.peerIDs = {};
    this.peerIDCallbacks = {};
    this.peerTokens = {};
    this.nextActionID = 1;
    this.actionCallbacks = {};
    this.actionTimeout = 3000;

    // domestic host?
    if (this.host.hostname == window.location.hostname) {
        this.isDomestic = true;
        var snickerdoodles = new cookies();
        this.domestic = snickerdoodles.get ('domestic'); // may be undefined
    }

    // ICE Server configuration
    if (options.iceServers)
        this.iceServers = options.iceServers
    else
        this.iceServers = WebRTC_ICE.slice();
}
inherit (Server, EventEmitter);


/**     @property/class Options
@member/Array[Object] iceServers
    A [list of ICE servers](https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration) that
    will fully override the default list.
*/


/**     @member/Function updateOptions

*/
Server.prototype.updateOptions = function (options) {
    if (options.iceServers)
        this.iceServers = options.iceServers;
};


/**     @member/Function goLive

*/
Server.prototype.goLive = function (callback) {
    if (this.isLive) {
        if (callback)
            if (this.liveSocketReady)
                process.nextTick (callback);
            else
                (this.liveCallbacks || (this.liveCallbacks = [])).push (callback);
        return;
    }
    this.isLive = true;

    if (this.isDomestic && (this.domestic || (this.domestic = (new cookies()).get ('domestic'))))
        this.liveSocket = socketio (this.host.origin, {
            query: '_domestic='+this.domestic
        });
    else
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
            console.log ('reply', pack);
            if (pack.events)
                self.station.sendEvents (pack.events);
            if (pack._id && Object.hasOwnProperty.call (self.actionCallbacks, pack._id)) {
                self.actionCallbacks[pack._id] (undefined, pack.status, pack.content || {});
                delete self.actionCallbacks[pack._id];
            }
        });

        self.liveSocket.on ('event', function (info) {
            self.station.sendEvents ([ info ]);
        });

        self.liveSocket.on ('peer', function (info) {
            if (info.token && Object.hasOwnProperty.call (self.peerTokens, info.token)) {
                self.peerTokens[info.token].processPeerMessage (info);
                return;
            }

            if (info.query)
                for (var i=0,j=self.peers.length; i<j; i++)
                    if (deepEqual (info.query, self.peers[i].query)) {
                        self.peers[i].processPeerMessage (info);
                        return;
                    }

            // a new peer is connecting to us!
            try {
                var peer = new Peer (self, info.query, info);
                self.peers.push (peer);
                if (info.token)
                    self.peerTokens[info.token] = peer;
            } catch (err) {
                console.log ('critical peer error', err.stack);
            }
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


/**     @member/Function getPeer

@argument/Object query
    To request a peer connection, you must pass a "credential document" to a handler on the server.
    This document is used to select the peer, and the handler makes the ultimate decision on whether
    the connection is allowed to proceed.
@callback
    @argument/Error|undefined err
    @argument/substation.Peer connectedPeer
*/
Server.prototype.getPeer = function (query, callback) {
    var peer;
    if (this.peers) for (var i=0,j=this.peers.length; i<j; i++)
        if (deepEqual (this.peers[i].query, query)) {
            peer = this.peers[i];
            break;
        }
    if (!peer) {
        peer = new Peer (this, query);
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
            // ( path, callback )
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
                path = arguments[1];
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

    // can we make a live transaction?
    if (this.liveSocketReady) {
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
    else if (this.isDomestic) {
        // domestic connection that wasn't logged in when we last checked
        // is it logged in now?
        var snickerdoodles = new cookies();
        if (this.domestic = snickerdoodles.get ('domestic'))
            (query || (query = {}))._domestic = this.domestic;
    }
    var fullpath = path[0] == '/' ? path : '/' + path;
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
Server.prototype.connectPeer = function (query) {
    this.liveSocket.emit ('link', query);
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
