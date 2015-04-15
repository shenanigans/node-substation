
var url             = require ('url');
var fs              = require ('fs');
var Path            = require ('path');
var http            = require ('http');
var https           = require ('https');
var async           = require ('async');
var SocketIO        = require ('socket.io');
var Busboy          = require ('busboy');
var Cookies         = require ('cookies');
var Likeness        = require ('likeness');
var cachew          = require ('cachew');
var uid             = require ('infosex').uid;
var Common          = require ('./Common');
var Router          = require ('./Router');
var Authentication  = require ('./Authentication');
var Reply           = require ('./Reply');

var actionPackValidator = new Likeness ({
    _id:            {
        '.type':        'number',
        '.gt':          0,
        '.optional':    true
    },
    method:         {
        '.type':        'string'
    },
    path:           {
        '.type':        'string'
    },
    query:          {
        '.type':        'object',
        '.optional':    true,
        '.arbitrary':   true,
        '.all':         {
            '.type':        'string'
        }
    },
    body:           {
        '.type':        'object',
        '.optional':    true,
        '.arbitrary':   true
    }
});

var peerRequestValidator = new Likeness ({
    _id:    { '.type':'number', '.optional':true, '.gt':0 },
    token:  { '.type':'string', '.length':uid.length, '.optional':true },
    peer:   { '.type':'object', '.arbitrary':true, '.optional':true },
    sdp:    { '.type':'string', '.lt':204800, '.optional':true },
    ICE:    { '.type':'string', '.lt':204800, '.optional':true }
});

var standalone =
    '<script type="text/javascript">'
  + fs.readFileSync (Path.resolve (__dirname, '../build/bundle.js')).toString()
  + '</script>'
  ;

/**     @struct substation.Configuration
@member/Number port
    @default `80`
@member/Boolean allowLiveGuests
    @default `false`
@member/Boolean binaryStreams
    If true, accept unknown content types and pass them, as well as `multipart/form-data` requests,
    to the Action as streams. The passed `request.body` will be a `ReadableStream` instance.
@member/Number bufferFiles
    @default `64000`
    Prebuffer trivial files into memory, up to the given number of bytes across all uploaded files.
    Handy for handling small file uploads (such as user avatars) in an application where file
    uploads are not a major feature.
@member/String LinksCollectionName
    @default `"Links"`
    Database collection name for storing "link tokens" which are used to pass WebRTC connection
    traffic after the initial connection has been allowed.
@mongodb.Collection|undefined LinksCollection
    Optionally override MongoDB setup however you want by passing in a pre-configured Collection
    driver instance.
@member/Number cacheLinks
    Maximum number of Link tokens to cache. Set to `0` or any falsey value to disable Link caching.
@member/Number linkCacheTimeout
    Maximum time, in milliseconds, to cache Link tokens.
*/
var DEFAULT_CONFIG = {
    port:                   80,
    allowLiveGuests:        false,
    binaryStreams:          false,
    bufferFiles:            64000,
    cacheLinks:             20480,
    linkCacheTimeout:       1000 * 60 * 5 // five minutes
};

/**     @struct substation.Context
    When a template is executed, the context is seeded with several properties. These properties are
    overriden by [content from the Action](substation.Action#content).
@member/String Standalone
    The compiled client, compiled by [browserify](http://browserify.org/) in standalone mode. Any
    other script on the page can access the library with `require ('substation');`.
@member/Error|undefined ActionError
    If the Action synchronously throws an Error, it is inserted here.
@member/String|undefined ServerError
    When the server throws `403` or `502` within the [Transport](substation.Transport) layer, a
    short message is provided.
*/


/**     @module/class substation.Transport
    @root
    Manages client connections over REST and Socket.io. Parses credentials and validates through
    [Authentication] (substation.Authentication). Builds [Replies](substation.Reply) and feeds them
    to [Actions](substation.Action) acquired from [Router](substation.Router).
@argument/substation parent
@argument/substation.Configuration config
*/
function Transport (parent, config) {
    this.parent = parent;
    this.config = config;
}


/**     @member/Function listen
    Begins listening on the configured port(s) and serving [Actions](substation.Action). If SSL is
    configured, keys and certificates will be loaded at this time. The server instance will be ready
    to accept requests before the callback goes off.
@callback
    @argument/Error|undefined err
*/
Transport.prototype.listen = function (callback) {
    this.authentication = new Authentication (this.parent, this.config.Authentication);
    this.createReactions();

    var server = http.createServer (this.reaction_REST);
    var io = SocketIO (server);
    io.use (this.handshake_SocketIO);
    io.on ('connection', this.reaction_SocketIO);

    if (this.config.cacheLinks)
        this.linkCache = new cachew.ChainCache (
            this.config.linkCacheTimeout,
            this.config.cacheLinks
        );

    server.listen (this.config.port, callback);
};


function react404 (request, response) {
    var headers;
    if (this.config.CORS)
        headers = {
            "Access-Control-Allow-Origin":      self.config.CORS.domains,
            "Access-Control-Allow-Methods":     self.config.CORS.methods,
            "Access-Control-Allow-Headers":     self.config.CORS.headers,
            "Content-Type":                     "text/plain; charset=utf-8",
            "Content-Length":                   9,
            "Connection":                       "close"
        };
    else
        headers = {
            "Content-Type":     "text/plain; charset=utf-8",
            "Content-Length":   9,
            "Connection":       "close"
        };
    response.writeHead (code, headers);
    response.end ('not found');
}


Transport.prototype.createReactions = function(){
    var router = this.parent.router;
    var backplane = this.parent.backplane;
    var authentication = this.authentication;
    var config = this.config;
    var station = this.parent;
    var globalTemplates = this.globalTemplates;
    var linkCache = this.linkCache;


    /**     @member/Function reaction_REST

    */
    this.reaction_REST = function (request, response) {
        console.log ('REST      -> '+request.method+' '+request.url);
        var streamClosed = false;
        var headers;
        if (config.CORS)
            headers = {
                "Access-Control-Allow-Origin":      config.CORS.domains,
                "Access-Control-Allow-Methods":     config.CORS.methods,
                "Access-Control-Allow-Headers":     config.CORS.headers
            };
        else
            headers = {};

        var action;
        var path = url.parse (request.url, true, false);
        var isJSON = Boolean (
            request.headers.accept
         && request.headers.accept.match (/application\/json/)
        );
        function closeRequest (code, msg) {
            if (isJSON) {
                headers['Content-Type'] = 'application/json; charset=utf-8';
                var msgStr = JSON.stringify (msg);
                headers['Content-Length'] = Buffer.byteLength (msgStr);
                if (!streamClosed)
                    headers['Connection'] = "close";
                response.writeHead (code, headers);
                response.end (msgStr);
                return;
            }
            var template;
            var codename = String (code);
            if (action && action.template && (
                Object.hasOwnProperty.call (
                    action.template,
                    codename
                )
             || Object.hasOwnProperty.call (
                    action.template,
                    codename = codename[0] + codename[1] + 'x'
                )
             || Object.hasOwnProperty.call (
                    action.template,
                    codename = codename[0] + 'xx'
                )
             || Object.hasOwnProperty.call (
                    action.template,
                    codename = 'xxx'
                )
            ) )
                template = action.template[codename];
            else if (globalTemplates && (
                Object.hasOwnProperty.call (
                    globalTemplates,
                    codename
                )
             || Object.hasOwnProperty.call (
                    globalTemplates,
                    codename = codename[0] + codename[1] + 'x'
                )
             || Object.hasOwnProperty.call (
                    globalTemplates,
                    codename = codename[0] + 'xx'
                )
             || Object.hasOwnProperty.call (
                    globalTemplates,
                    codename = 'xxx'
                )
            ) )
                template = globalTemplates[codename];
            else {
                // no template
                headers['Content-Type'] = 'application/json; charset=utf-8';
                var msgStr = JSON.stringify (msg);
                headers['Content-Length'] = Buffer.byteLength (msgStr);
                if (!streamClosed)
                    headers['Connection'] = "close";
                response.writeHead (code, headers);
                response.end (msgStr);
                return;
            }

            // run the template
            headers['Content-Type'] = 'text/html; charset=utf-8';
            headers['Content-Length'] = Buffer.byteLength (html);
            var sent = false;
            var html = template ({ ServerError:msg }, function (err, html) {
                if (sent) {
                    console.log (
                        'WARNING - attempted to fullfill template both sync and async'
                    );
                    return;
                }

                if (err) {
                    console.log (
                        'WARNING - error message from async after sync completed'
                    );
                    return;
                }

                if (!streamClosed)
                    headers['Connection'] = "close";
                response.writeHead (code, headers);
                response.end (html);
            });
            if (html) {
                sent = true;
                if (!streamClosed)
                    headers['Connection'] = "close";
                response.writeHead (code, headers);
                response.end (html);
            }
        }

        var path = url.parse (request.url, true);
        router.getAction (request.url, request.method, function (foundAction, params) {
            action = foundAction;

            if (!action) {
                closeRequest (404, 'unknown action');
                return;
            }

            var cookies = new Cookies (request, response);
            authentication.getSession (path, cookies, request, response, function (err, authInfo) {
                if (err) {
                    console.log ('session acquisition error', err.stack);
                    closeRequest (403, 'unknown authentication failure');
                    return;
                }

                // is this Action prepared to accept a request of the current auth level?
                // TODO

                var reply = new Reply (function (status, events, content) {
                    function closeRequest (code, type, msg) {
                        headers['Content-Type'] = type;
                        headers["Content-Length"] = Buffer.byteLength (msg);

                        if (!streamClosed)
                            headers.Connection = "close";

                        response.writeHead (code, headers);
                        response.end (msg);
                    }

                    if (!action.template) {
                        console.log ('action has no template');
                        headers['Content-Type'] = 'application/json; charset=utf-8';
                        var msgStr = JSON.stringify ({ events:events, content:content });
                        headers['Content-Length'] = Buffer.byteLength (msgStr);
                        if (!streamClosed)
                            headers['Connection'] = "close";
                        response.writeHead (status, headers);
                        response.end (msgStr);
                        return;
                    }

                    if (isJSON)
                        return closeRequest (
                            status,
                            'application/json; charset=utf-8',
                            JSON.stringify ({ events:events, content:content })
                        );

                    // select template by status code
                    var statusStr = String (status);
                    var template =
                        action.template[status]
                     || action.template[status[0]+status[1]+'x']
                     || action.template[status[0]+'xx']
                     || action.template['200']
                     ;
                    if (!template)
                        return closeRequest (
                            status,
                            'application/json; charset=utf-8',
                            JSON.stringify ({ events:events, content:content })
                        );

                    var templateContext;
                    if (config.context) {
                        templateContext = Common.clone (config.context);
                        if (action.config.context)
                            Common.merge (templateContext, action.config.context);
                        Common.merge (templateContext, content);
                    } else if (action.config.context) {
                        templateContext = Common.clone (action.config.context);
                        Common.merge (templateContext, content);
                    } else
                        templateContext = Common.clone (content);
                    templateContext.Standalone = standalone;

                    // inject authentication information into the context
                    templateContext.authentication = authInfo.export();

                    // "substationEvents" boilerplate injects events into template context
                    var eventScript =
                        '<script type="text/javascript">(function(){'
                      + 'var substation=require("substation");substation.sendEvents('
                      + JSON.stringify (events)
                      + ');})()</script>'
                      ;
                    templateContext.SubstationEvents = eventScript;

                    // process template
                    var sent = false;
                    var html = template (templateContext, function (err, html) {
                        if (sent) {
                            console.log (
                                'WARNING - attempted to fullfill template both sync and async'
                            );
                            return;
                        }

                        if (err) {
                            console.log (
                                'WARNING - error message from async after sync completed'
                            );
                            return;
                        }

                        closeRequest (status, 'text/html; charset=utf-8', html);
                    });
                    if (html) {
                        sent = true;
                        return closeRequest (status, 'text/html; charset=utf-8', html);
                    }
                });

                // build up the request and context objects
                var actionRequest = {};
                var contentType = request.headers['content-type'];
                var actionRequest = {
                    url:        path,
                    method:     request.method,
                    format:     contentType,
                    query:      path.query || {},
                    params:     params || []
                };

                // binary streams
                if (
                    action.binaryStreams
                 && contentType != 'application/json'
                 && contentType != 'application/x-www-form-urlencoded'
                ) {
                    actionRequest.stream = request;
                    actionRequest.contentType = contentType;

                    // when this stream closes, disarm the connection terminator
                    request.on ('end', function(){
                        streamClosed = true;
                    });

                    action.run (station, authInfo, actionRequest, reply);
                    return;
                }

                // pass form requests over to busboy
                if (
                    contentType == 'application/x-www-form-urlencoded'
                 || contentType == 'multipart/form-data'
                ) {
                    var boy = new Busboy ({
                        headers:    request.headers,
                        limits:     {

                        }
                    });

                    var body = {};
                    boy.on ('field', function (key, value) {
                        body[key] = value;
                    });

                    var files = [];
                    boy.on ('file', function (key, stream, filename, encoding, mimetype) {
                        var fileDoc = {
                            filename:       filename,
                            encoding:       encoding,
                            contentType:    mimetype
                        };
                        files.push (fileDoc);

                        var chunks = [];
                        stream.on ('data', function (chunk) {
                            chunks.push (chunk);
                        });
                        stream.on ('end', function(){
                            fileDoc.data = Buffer.concat (chunks);
                        });
                    });

                    boy.on ('finish', function(){
                        actionRequest.body = body;
                        actionRequest.files = files;

                        action.run (station, authInfo, actionRequest, reply);
                    });

                    boy.on ('error', function (err) {
                        console.log ('form parsing error', err);
                        return closeRequest (400, { ServerError:'malformed request' });
                    });
                    request.pipe (boy);
                    return;
                }

                // buffer and parse the body
                var bodyChunks = [];
                var total = 0;
                request.on ('data', function (buf) {
                    total += buf.length;
                    if (total > action.maxBodyLength)
                        return closeRequest (413, { ServerError:'request entity too large' });
                    bodyChunks.push (buf);
                });

                request.on ('end', function(){
                    streamClosed = true;
                    if (bodyChunks.length) {
                        var fullBody = Buffer.concat (bodyChunks);

                        if (contentType == 'application/json') {
                            var reqStr = fullBody.toString();
                            try {
                                actionRequest.body = JSON.parse (reqStr);
                            } catch (err) {
                                return closeRequest (400, { ServerError:'malformed request' });
                            }
                        } else actionRequest.body = fullBody;
                    }
                    try {
                        action.run (station, authInfo, actionRequest, reply);
                    } catch (err) {
                        console.log ('ERROR - action threw an error');
                        console.log (err);
                        return closeRequest (403, { ServerError:'forbidden' });
                    }
                });
            });
        });
    };


    /**     @member/Function handshake_SocketIO

    */
    this.handshake_SocketIO = function (socket, callback) {
        var allowGuest = Boolean (config.allowGuest);
        var cookies = new Cookies (socket.request, socket.response);
        var path = url.parse (socket.request.url);
        authentication.getSession (
            path,
            cookies,
            socket.request,
            socket.response,
            function (err, agent) {
                if (err) return callback (err);
                if (agent.user && agent.client) {
                    backplane.setLive (
                        agent.user,
                        agent.client,
                        socket,
                        true
                    );
                    socket.on ('disconnect', function(){
                        backplane.setLive (
                            agent.user,
                            agent.client,
                            socket,
                            false
                        );
                    });
                } else if (!allowGuest)
                    return callback (new Error ('not authorized'));
                socket.agent = agent;
                callback();
            }
        );
    };


    /**     @member/Function reaction_SocketIO

    */
    this.reaction_SocketIO = function (socket, callback) {
        socket.on ('action', function (actionDoc) {
            try {
                actionPackValidator.validate (actionDoc);
            } catch (err) {
                // invalid request pack
                console.log ('invalid pack', err);
                return;
            }
            console.log ('Socket.io -> '+actionDoc.method+' '+actionDoc.path);
            router.getAction (actionDoc.path, actionDoc.method, function (action, params) {
                if (!action) {
                    // reply 404
                    console.log ('no action');
                    return;
                }

                var reply = new Reply (function (status, events, content) {
                    console.log ('reply', actionDoc._id, status, events, content);
                    var replyDoc = { status:status };
                    if (events)
                        replyDoc.events = events;
                    if (content)
                        replyDoc.content = content;
                    if (actionDoc._id)
                        replyDoc._id = actionDoc._id;
                    socket.emit ('reply', replyDoc);
                });

                var request = {
                    query:  actionDoc.query || {},
                    body:   actionDoc.body || {},
                    params: params
                };
                action.run (station, socket.agent, request, reply);
            })
        });

        socket.on ('peer', function (info) {
            console.log ('peer message', info);
            if (!socket.agent.isLoggedIn) {
                var pushback = { error:'FORBIDDEN' };
                if (info._id)
                    pushback._id = info._id;
                socket.emit ('peer', pushback);
                return;
            }

            if ((function(){
                try {
                    peerRequestValidator.validate (info);
                } catch (err) {
                    // invalid peer
                    var pushback = { error:'INVALID' };
                    if (info._id)
                        pushback._id = info._id;
                    socket.emit ('peer', pushback);
                    return true;
                }
            })())
                return;

            if (!info.token) {
                if (!info.peer) {
                    var pushback = { error:'INVALID' };
                    if (info._id)
                        pushback._id = info._id;
                    socket.emit ('peer', pushback);
                    return;
                }

                // pass to the application for processing
                station.emit (
                    'peerRequest',
                    socket.agent,
                    info.peer,
                    function (/* userID, clientID, aliceInfo, callback */) {
                        var userID, clientID, aliceInfo;
                        switch (arguments.length) {
                            case 2:
                                userID = arguments[0];
                                aliceInfo = arguments[1];
                                break;
                            case 3:
                                userID = arguments[0];
                                aliceInfo = arguments[1];
                                callback = arguments[2];
                                break;
                            default:
                                userID = arguments[0];
                                clientID = arguments[1];
                                aliceInfo = arguments[2];
                                callback = arguments[3];
                        }
                        var bobDef = { user:userID };
                        if (clientID)
                            bobDef.client = clientID;
                        var aliceDef = { user:socket.agent.user, client:socket.agent.client };
                        if (info._id)
                            aliceDef._id = info._id;
                        uid.craft (function (token) {
                            station.LinksCollection.insert ({
                                _id:        token,
                                Alice:      aliceDef,
                                Bob:        bobDef,
                                expires:    (new Date()).getTime() + ( 1000 * 60 * 20 ) // 20 minutes
                            }, function (err) {
                                if (err) {
                                    if (callback)
                                        callback (err);
                                    return;
                                }
                                var peerEvent = {
                                    init:   true,
                                    token:  token,
                                    sdp:    info.sdp,
                                    peer:   aliceInfo
                                };
                                if (info.ICE)
                                    peerEvent.ICE = info.ICE;
                                station.backplane.sendPeerEvent (
                                    userID,
                                    clientID,
                                    peerEvent,
                                    callback
                                );
                            });
                        });
                    }
                );
                return;
            }

            function cleanup (err, received) {
                if (!err && received)
                    return;

                var pushback = { error:'OFFLINE' };
                if (info._id)
                    pushback._id = info._id;
                station.emit ('peer', pushback);
                return;
            }

            // evaluate the token for potential pass-through
            var passDoc = { token:info.token };
            if (info.sdp)
                passDoc.sdp = info.sdp;
            if (info.ICE)
                passDoc.ICE = info.ICE;

            // is the token valid?
            var linkRec, sender, recipient;
            var now = (new Date()).getTime();
            if (linkCache && (linkRec = linkCache.get (info.token))) {
                // found cached token record
                if (linkRec.expires < now) {
                    var pushback = { error:'FORBIDDEN' };
                    if (info._id)
                        pushback._id = info._id;
                    socket.emit ('peer', pushback);
                    return;
                }

                if (linkRec.Alice.user == socket.agent.user)
                    recipient = linkRec.Bob;
                else
                    recipient = linkRec.Alice;

                if (recipient._id)
                    passDoc._id = recipient._id;

                backplane.sendPeerEvent (
                    recipient.user,
                    recipient.client,
                    passDoc,
                    cleanup
                );
            }

            // ask the database about the presented token
            station.LinksCollection.findOne ({ _id:info.token }, function (err, linkRec) {
                if (err || !linkRec) {
                    var pushback = { error:'FORBIDDEN' };
                    if (info._id)
                        pushback._id = info._id;
                    socket.emit ('peer', pushback);
                    return;
                }

                if (linkRec.Alice.user == socket.agent.user)
                    recipient = linkRec.Bob;
                else
                    recipient = linkRec.Alice;

                if (recipient._id)
                    passDoc._id = recipient._id;

                backplane.sendPeerEvent (
                    recipient.user,
                    recipient.client,
                    passDoc,
                    cleanup
                );
            });
        });
    };
};


module.exports = Transport;
