
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
        '.type':        'integer',
        '.gte':         0,
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

var peerEventValidator = new Likeness ({
    token:  { '.type':'string', '.length':uid.length },
    to:     { '.type':'string', '.length':uid.length },
    init:   { '.type':'boolean', '.value':true, '.optional':true },
    sdp:    {
        '.optional':    true,
        type:   { '.type':'string', '.anyValue':[ 'offer', 'answer' ] },
        sdp:    { '.type':'string', '.lt':204800 }
    },
    ICE:    { '.optional':true, '.type':'string', '.lt':204800 }
});

var standalone =
    '<script type="text/javascript">'
  + fs.readFileSync (Path.resolve (__dirname, '../build/bundle.js')).toString()
  + '</script>'
  ;

// for handling cookies during Socket.io handshake
var FauxResponse = function(){};
FauxResponse.prototype.setHeader = function(){};
FauxResponse.prototype.getHeader = function(){ return []; };

/**     @struct substation.Configuration
@member/Number port
    @default `80`
    Accept `http` requests and `Socket.io` connections on this port.
@member/Boolean allowForeignSockets
    @default `true`
    Whether a user is permitted to open a `Socket.io` connection from a context without same-origin
    privelege, such as an iframe. Such connections perform all actions with [isDomestic]
    (substation.Agent#isDomestic) set to `false`.
@member/Boolean binaryStreams
    If true, accept arbitrary content types and pass them, as well as `multipart/form-data` requests,
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
*/
var DEFAULT_CONFIG = {
    port:                   80,
    allowForeignSockets:    true,
    binaryStreams:          false,
    bufferFiles:            64000,
    LinksCollectionName:    "Links"
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
    var self = this;
    this.authentication.init (function(){
        var server = http.createServer (self.reaction_REST);
        var io = SocketIO (server, {
            pingInterval:   5000,
            pingTimeout:    10000
        });
        io.use (self.handshake_SocketIO);
        io.on ('connection', self.reaction_SocketIO);
        server.listen (self.config.port, callback);
    });
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
        var path = url.parse (request.url, true);
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
                    codename = '200'
                )
            ) )
                template = action.template[codename];
            else if (globalTemplates && (
                Object.hasOwnProperty.call (
                    globalTemplates,
                    codename = String (code)
                )
             || Object.hasOwnProperty.call (
                    globalTemplates,
                    codename = '200'
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
                    station.logger.error ({
                        action:     action.name || action.pattern.toString.slice (1, -1),
                        status:     code,
                        error:      "template provided asynchronous html after synchronous html"
                    });
                    return;
                }

                if (err) {
                    station.logger.error ({
                        action:     action.name || action.pattern.toString.slice (1, -1),
                        status:     code,
                        error:      "template provided asynchronous error after synchronous html"
                    });
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

        if (request.method == 'OPTIONS') {
            var body = router.getOptions (request.url);
            headers['Allow'] = Object.keys (body).join (',');
            headers['Content-Type'] = 'application/json; charset=utf-8';
            var msgStr = JSON.stringify ({ content:body });
            headers['Content-Length'] = Buffer.byteLength (msgStr);
            if (!streamClosed)
                headers['Connection'] = "close";
            response.writeHead (200, headers);
            response.end (msgStr);
            return;
        }

        router.getAction (request.url, request.method, function (foundAction, params) {
            action = foundAction;

            if (!action) {
                closeRequest (404, 'unknown action');
                return;
            }

            var cookies = new Cookies (request, response);
            authentication.getSession (path, cookies, function (err, authInfo) {
                if (err) {
                    station.logger.error ('session acquisition error', err);
                    closeRequest (403, 'unknown authentication failure');
                    return;
                }

                var reply = new Reply (function (status, events, content) {

                    function closeRequest (code, type, msg) {
                        station.logger.info ({
                            transport:  'http',
                            method:     request.method,
                            path:       path.path,
                            action:     action.name,
                            status:     status,
                            format:     isJSON || !template ? 'json' : 'html'
                        });

                        headers['Content-Type'] = type;
                        headers["Content-Length"] = Buffer.byteLength (msg);
                        if (reply.redirectURL)
                            headers.Location = reply.redirectURL;

                        if (!streamClosed)
                            headers.Connection = "close";

                        response.writeHead (code, headers);
                        response.end (msg);
                    }

                    if (!action.template)
                        return closeRequest (
                            status,
                            'application/json',
                            JSON.stringify ({ events:events, content:content })
                        );

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
                            station.logger.warn (
                                'attempted to fullfill template both sync and async',
                                {
                                    path:   action.route,
                                    method: action.method,
                                    status: status
                                }
                            );
                            return;
                        }

                        if (err) {
                            station.logger.warn (
                                'error message from async after sync completed',
                                {
                                    path:   action.route,
                                    method: action.method,
                                    status: status
                                }
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
                queryDoc = path.query || {};
                delete queryDoc._domestic;
                var actionRequest = {
                    method:     request.method,
                    format:     contentType,
                    query:      queryDoc,
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
                        station.logger.warn ('form parsing error', {
                            path:   action.route,
                            method: action.method,
                            status: status
                        });
                        return closeRequest (400, { ClientError:'malformed request' });
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
                        return closeRequest (413, { ClientError:'request entity too large' });
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
                                return closeRequest (400, { ClientError:'malformed request' });
                            }
                        } else actionRequest.body = fullBody;
                    }
                    try {
                        action.run (station, authInfo, actionRequest, reply);
                    } catch (err) {
                        station.logger.warn ('action threw an error', err);
                        return closeRequest (403, { ClientError:'forbidden' });
                    }
                });
            });
        });
    };


    /**     @member/Function handshake_SocketIO

    */
    this.handshake_SocketIO = function (socket, callback) {
        var cookies = new Cookies (socket.request, new FauxResponse());
        var path = url.parse (socket.request.url, true);
        authentication.getSession (path, cookies, function (err, agent) {
            if (err) return callback (err);
            if (!agent.isLoggedIn || (!config.allowForeignSockets && !agent.isDomestic))
                return callback (new Error ('not authorized'));

            socket.agent = agent;
            socket.session = cookies.get ('session');

            uid.craft (function (SID) {
                socket.SID = SID;
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
                callback();
            });
        });
    };


    /**     @member/Function reaction_SocketIO

    */
    this.reaction_SocketIO = function (socket, callback) {
        socket.on ('action', function (actionDoc) {
            try {
                actionPackValidator.validate (actionDoc);
            } catch (err) {
                // invalid request pack
                station.logger.warn ('invalid action', { transport: 'Socket.io' });
                return;
            }

            var path = actionDoc.path;
            if (path[0] != '/')
                path = '/'+path;

            if (actionDoc.method == 'OPTIONS') {
                var body = station.router.getOptions (path);
                var response = { status:200, path:path, content:body };
                if (actionDoc._id)
                    response._id = actionDoc._id;
                socket.emit ('reply', response);
                return;
            }

            router.getAction (path, actionDoc.method, function (action, params) {
                if (!action) {
                    // reply 404
                    station.logger.info ({
                        transport:  'Socket.io',
                        method:     actionDoc.method,
                        path:       path,
                        action:     null,
                        status:     404
                    });
                    return;
                }

                var reply = new Reply (function (status, events, content) {
                    var replyDoc = { status:status };
                    if (events)
                        replyDoc.events = events;
                    if (content)
                        replyDoc.content = content;
                    if (actionDoc._id !== undefined)
                        replyDoc._id = actionDoc._id;

                    station.logger.info ({
                        transport:  'Socket.io',
                        method:     actionDoc.method,
                        path:       path,
                        action:     action.name,
                        status:     status
                    });

                    socket.emit ('reply', replyDoc);
                });

                var request = {
                    method: actionDoc.method,
                    query:  actionDoc.query || {},
                    params: params,
                    body:   actionDoc.body || {}
                };
                action.run (station, socket.agent, request, reply);
            })
        });

        socket.on ('link', function (query) {
            // pass to the application for processing
            station.emit (
                'peerRequest',
                socket.agent,
                query,
                function (/* userID, clientID, aliceInfo, callback */) {
                    var userID, clientID, aliceInfo, callback;
                    switch (arguments.length) {
                        case 2:
                            userID = arguments[0];
                            aliceInfo = arguments[1];
                            break;
                        case 3:
                            userID = arguments[0];
                            if (typeof arguments[2] == 'function') {
                                aliceInfo = arguments[1];
                                callback = arguments[2];
                            } else {
                                clientID = arguments[1];
                                aliceInfo = arguments[2];
                            }
                            break;
                        default:
                            userID = arguments[0];
                            clientID = arguments[1];
                            aliceInfo = arguments[2];
                            callback = arguments[3];
                    }
                    var bobDef = { query:query, user:userID };
                    if (clientID)
                        bobDef.client = clientID;
                    var aliceDef = { query:aliceInfo, user:socket.agent.user };
                    // user -> user or client -> client, no mixed links
                    if (clientID)
                        aliceDef.client = socket.agent.client;

                    var tryNum = 1;
                    uid.craft (function writeLink (token) {
                        if (tryNum++ > 3)
                            return callback (new Error ('collision'));

                        function cleanup (err, didReceive) {
                            if (didReceive) return;

                            // nobody awake to connect to link
                            // cull the link record and subdoc
                            station.logger.warn ('Link failed', {
                                token:      token,
                                sender:     aliceDef,
                                receiver:   bobDef
                            });
                            station.LinksCollection.update (
                                { _id:token },
                                { $set:{ closed:true } },
                                { w:0 }
                            );
                            station.BackplaneCollection.update (
                                { _id:userID },
                                { $pull:{ link:{ token:token } } },
                                { w:0 }
                            );
                            station.BackplaneCollection.update (
                                { _id:socket.agent.user },
                                { $pull:{ link:{ token:token } } },
                                { w:0 }
                            );
                        }

                        // find the Alice user IFF they don't have a link already selected
                        station.BackplaneCollection.findAndModify (
                            { _id:socket.agent.user, link:{ $not:{ $elemMatch:{
                                client:     socket.agent.client,
                                tgtUser:    userID,
                                tgtClient:  clientID
                            } } } },
                            { _id:1 },
                            { $push:{ link:{
                                token:      token,
                                client:     clientID ? socket.agent.client : null,
                                tgtUser:    userID,
                                tgtClient:  clientID
                            } } },
                            { fields:{ _id:true } },
                            function (err, rec) {
                                if (err) return callback (err);
                                if (!rec) {
                                    // they DO have a link already selected
                                    // abandon token and use existing Link
                                    station.BackplaneCollection.findOne (
                                        {
                                            _id:    socket.agent.user,
                                            link:   { $elemMatch:{
                                                client:     socket.agent.client,
                                                tgtUser:    userID,
                                                tgtClient:  clientID
                                            } }
                                        },
                                        { 'link.$':true },
                                        function (err, rec) {
                                            if (err) return callback (err);
                                            if (!rec || !rec.link || !rec.link.length)
                                                return writeLink (token);
                                            station.LinksCollection.update (
                                                { _id:rec.link[0].token },
                                                { $set:{ closed:false } },
                                                function (err) {
                                                    var peerEvent = {
                                                        init:   true,
                                                        token:  rec.link[0].token,
                                                        query:  aliceInfo,
                                                        from:   socket.SID
                                                    };
                                                    station.backplane.routePeerEvent (
                                                        peerEvent,
                                                        socket.agent,
                                                        function (err) {
                                                            if (err) station.logger.error (
                                                                'peer event error',
                                                                err
                                                            );
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                    return;
                                }

                                // new Link accepted, finish database updates
                                async.parallel ([
                                    function (callback) {
                                        station.logger.info ('Link opened', {
                                            token:      token,
                                            sender:     aliceDef,
                                            receiver:   bobDef
                                        });
                                        station.LinksCollection.insert ({
                                            _id:        token,
                                            party:      [ aliceDef, bobDef ],
                                            closed:     false
                                        }, callback);
                                    },
                                    function (callback) {
                                        station.BackplaneCollection.update (
                                            { _id:userID },
                                            { $push:{ link:{
                                                client:     clientID,
                                                token:      token,
                                                tgtUser:    socket.agent.user,
                                                tgtClient:  clientID ? socket.agent.client : null
                                            } } },
                                            { upsert:true, w:0 },
                                            callback
                                        );
                                    }
                                ], function (err) {
                                    if (err) {
                                        if (callback)
                                            callback (err);
                                        return;
                                    }

                                    var peerEvent = {
                                        init:   true,
                                        token:  token,
                                        query:  aliceInfo,
                                        from:   socket.SID
                                    };
                                    station.backplane.sendPeerEvent (
                                        userID,
                                        clientID,
                                        peerEvent,
                                        undefined,
                                        cleanup
                                    );
                                });
                            }
                        );
                    });
                }
            );
        });

        socket.on ('peer', function (info) {
            if (!socket.agent.isLoggedIn) {
                socket.emit ('peer', { error:'FORBIDDEN' });
                return;
            }

            if ((function(){
                try {
                    peerEventValidator.validate (info);
                } catch (err) {
                    // invalid peer event message
                    socket.emit ('peer', { error:'INVALID' });
                    return true;
                }
            })())
                return;
            if (( info.sdp || info.ICE ) && !info.to) {
                socket.emit ('peer', { token:info.token, error:'INVALID' });
                return;
            }

            function cleanup (err, received) {
                if (err || !received)
                    station.emit ('peer', { token:info.token, error:'OFFLINE' });
            }

            // evaluate the token for pass-through service
            var passDoc = peerEventValidator.transform ({}, info);
            passDoc.from = socket.SID;
            station.backplane.routePeerEvent (passDoc, socket.agent, function (err) {
                if (err)
                    station.logger.error ('peer event routing error', err);
            });
        });
    };
};


module.exports = Transport;
