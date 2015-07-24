
var http = require ('http');
var crypto = require ('crypto');
var filth = require ('filth');
var likeness = require ('likeness');
var RemoteAgent = require ('./RemoteAgent');
var Reply = require ('submergence').Reply;

function timeDifference (start, end) {
    var micro = Math.floor (( end[1] - start[1] ) / 1000 );
    micro += 1000000 * ( end[0] - start[0] );
    return micro;
}

var requestBodyValidator = new likeness ({
    transport:      { '.type':'string', '.anyValue':[ 'http', 'socket.io' ] },
    params:         {
        '.type':        'array',
        '.maxVals':     32,
        '.each':        { '.type':'string', '.maxLength':128 }
    },
    query:          {
        '.arbitrary':   true,
        '.each':        { '.type':'string', '.maxLength':256 }
    },
    body:           { '.optional':true, '.arbitrary':true }
});

/**     @module/class substation:RemoteTransport

*/
function RemoteTransport (config, parent) {
    this.config = config;
    this.parent = parent;
    this.logger = parent.logger;
}
module.exports = RemoteTransport;

/**     @member/Function listen

*/
var SIMPLE_EVENTS = {
    userOnline:     true,
    userOffline:    true,
    clientOnline:   true,
    clientOffline:  true
};
RemoteTransport.prototype.listen = function (port, router, callback) {
    if (!this.config.APIKey)
        return this.logger.fatal ('API Key not configured');
    var self = this;

    var hasher = crypto.createHash ('sha256');
    hasher.update (this.config.APIKey);
    hasher.update ('~substation~');
    hasher.update (this.config.domain || 'foo.bar.biz');
    var keyHash = hasher.digest ('base64');
    var requestHeadersValidator = new likeness ({
        '.arbitrary':               true,
        'x-substation-action':      {
            '.optional':    true,
            '.type':        'string',
            '.maxLength':   192,
            '.error':       'x-substation-action'
        },
        'x-substation-event':      {
            '.optional':    true,
            '.type':        'string',
            '.anyValue':    [
                'userOnline',
                'userOffline',
                'clientOnline',
                'clientOffline',
                'peerRequest',
                'liveConnection'
            ],
            '.error':       'x-substation-event'
        },
        'x-substation-url':      {
            '.optional':    true,
            '.description': 'Only contains GET params when streaming requests are used.',
            '.type':        'string',
            '.maxLength':   256,
            '.error':       'x-substation-url'
        },
        'x-substation-key':         {
            '.type':        'string',
            '.value':       keyHash,
            '.error':       'x-substation-key'
        },
        'x-substation-transport':   {
            '.optional':    true,
            '.type':        'string',
            '.anyValue':    [ 'http', 'socket.io' ],
            '.error':       'x-substation-transport'
        },
        'x-substation-format':      {
            '.optional':    true,
            '.type':        'string',
            '.anyValue':    [ 'json', 'html' ],
            '.error':       'x-substation-format'
        },
        'x-substation-user':  {
            '.optional':    true,
            '.type':        'string',
            '.maxLength':   128,
            '.error':       'x-substation-user'
        },
        'x-substation-client':  {
            '.optional':    true,
            '.type':        'string',
            '.maxLength':   128,
            '.error':       'x-substation-client'
        },
        'x-substation-active':  {
            '.optional':    true,
            '.type':        'string',
            '.value':       'yes',
            '.error':       'x-substation-active'
        },
        'x-substation-domestic':  {
            '.optional':    true,
            '.type':        'string',
            '.value':       'yes',
            '.error':       'x-substation-domestic'
        },
        'x-substation-binary':  {
            '.optional':    true,
            '.type':        'string',
            '.value':       'yes',
            '.error':       'x-substation-binary'
        },
        'x-substation-failed':  {
            '.description': 'indicates that the body should be rendered to produce an error report',
            '.optional':    true,
            '.type':        'string',
            '.length':      3,
            '.error':       'x-substation-failed'
        },
        '.dependencies':        {
            'x-substation-action':  [
                'x-substation-url',
                'x-substation-transport',
                'x-substation-format'
            ],
            'x-substation-user':    [
                'x-substation-client'
            ]
        }
    });

    var logger = this.logger;
    var config = this.config;
    var rpcServer = http.createServer (function (request, response) {
        var startTime = process.hrtime();

        if (config.safeRemoteRequests) try {
            requestHeadersValidator.validate (request.headers);
        } catch (err) {
            logger.warn ({
                err:        err,
                url:        request.url,
                ip:         request.connection.remoteAddress,
                headers:    request.headers
            }, 'request was not a valid Action');
            // close connection with 400
            return;
        }

        // server event forwarding
        if (request.headers['x-substation-event']) {
            var eventName = request.headers['x-substation-event'];
            function closeEvent (status, body) {
                var headers = {};
                if (body) {
                    var bodyStr = JSON.stringify (body);
                    response.writeHead (status, { 'Content-Length':Buffer.byteLength (bodyStr) });
                    response.write (bodyStr);
                    response.end();
                    return;
                }
                response.writeHead (status);
                response.end();
            }

            var total = 0;
            var chunks = [];
            request.on ('data', function (chunk) {
                total += chunk.length;
                if (total > 2048) {
                    logger.warn ('remote request sent oversized server event body');
                    request.removeAllListeners();
                    request.emit ('end');
                    response.end();
                    return closeEvent ('400');
                }
                chunks.push (chunk);
            });
            request.on ('error', function (err) {
                logger.warn (
                    { err:err, ip:request.connection.remoteAddress },
                    'remote request server event connection error'
                );
            });
            request.on ('end', function(){
                try {
                    var body = JSON.parse (Buffer.concat (chunks).toString());
                } catch (err) {
                    logger.warn (
                        { err:err, ip:request.connection.remoteAddress },
                        'remote request server event was invalid json'
                    );
                    return closeEvent ('400');
                }

                if (SIMPLE_EVENTS[eventName]) {
                    self.parent.emit (
                        eventName,
                        body.domain,
                        body.user,
                        body.client
                    );
                    return closeEvent ('200');
                }

                if (!self.parent.listeners (eventName).length)
                    return closeEvent ('200');

                var agent = new RemoteAgent (
                    self.config,
                    body.domain,
                    body.agent.user,
                    body.agent.client,
                    body.agent.isLoggedIn,
                    body.agent.isDomestic,
                    body.agent.rememberMe
                );

                if (eventName == 'peerRequest') {
                    self.parent.emit (
                        'peerRequest',
                        agent,
                        body.query,
                        function (/* userID, clientID, aliceInfo */) {
                            var userID, clientID, aliceInfo;
                            userID = arguments[0];
                            if (arguments.length == 2)
                                aliceInfo = arguments[1];
                            else {
                                clientID = arguments[1];
                                aliceInfo = arguments[2];
                            }
                            closeEvent ('200', {
                                user:   userID,
                                client: clientID,
                                info:   aliceInfo
                            });
                            if (callback)
                                callback();
                        }
                    );
                    return;
                }

                // liveConnection
                var reply = new Reply (function (status, events, content, html) {
                    closeEvent ('200', events);
                });
                self.parent.emit ('liveConnection', agent, reply);
            });
            return;
        }

        // forwarded Action
        var agent = new RemoteAgent (
            config,
            self.config.domain || request.headers.host || '',
            request.headers['x-substation-user'] || '',
            request.headers['x-substation-client'] || '',
            Boolean (request.headers['x-substation-active']),
            Boolean (request.headers['x-substation-domestic']),
            Boolean (request.headers['x-substation-remember-me'])
        );
        var actionRequest = {
            url:        request.headers['x-substation-url'],
            transport:  request.headers['x-substation-transport'],
            format:     request.headers['x-substation-format']
        };
        var streaming = Boolean (request.headers['x-substation-binary']);
        var parsedURL;
        if (streaming) {
            parsedURL = url.parse (request.headers['x-substation-url'], true);
            actionRequest.url = parsedURL.pathname;
        } else
            actionRequest.url = request.headers['x-substation-url'];

        var actionName = request.headers['x-substation-action'];
        router.getActionByName (actionName, function (err, action) {
            if (err) {
                logger.error ({ action:actionName, err:err }, 'action routing error');
                // close connection with 502
                return;
            }

            if (!action) {
                logger.warn ({
                    url:        actionRequest.url,
                    ip:         request.connection.remoteAddress,
                    headers:    request.headers,
                    action:     actionName
                }, 'unknown action requested');
                // close connection with 404
                return;
            }

            var reply = new Reply (function (status, events, content, html) {
                // every future ending point from here uses this function to close the response
                function closeResponse (code, type, msg) {
                    self.parent.logger.info ({
                        transport:  actionRequest.transport,
                        method:     actionRequest.method,
                        path:       actionRequest.url,
                        action:     action.name,
                        status:     status,
                        latency:    timeDifference (startTime, process.hrtime()),
                        format:     actionRequest.format
                    }, 'action');

                    var headers = {
                        'Content-Type':     type,
                        'Content-Length':   Buffer.byteLength (msg),
                        'X-Substation-Key': keyHash
                    };
                    if (code == '200')
                        headers['X-Substation-Status'] = status;
                    if (reply.redirectURL)
                        headers.Location = reply.redirectURL;
                    if (!streamClosed)
                        headers.Connection = "close";

                    if (agent.changed) {
                        headers['X-Substation-User'] = agent.changed.user;
                        if (agent.changed.client)
                            headers['X-Substation-Client'] = agent.changed.client;
                        headers['X-Substation-Agent-Status'] = agent.changed.setStatus;
                        if (agent.changed.rememberMe)
                            headers['X-Substation-Remember-Me'] = 'yes';
                    }

                    if (reply.redirectURL)
                        headers.Location = reply.redirectURL;
                    headers['Content-Type'] = Buffer.byteLength (msg);
                    response.writeHead (code, headers);
                    response.end (msg);
                }

                if (actionRequest.format == 'json' || !action.template)
                    return closeResponse (
                        '200',
                        'application/json; charset=utf-8',
                        JSON.stringify ({ status:status, events:events, content:content })
                    );

                // assemble the template context
                var templateContext;
                if (config.context) {
                    templateContext = filth.clone (config.context);
                    if (action.config.context)
                        filth.merge (templateContext, action.config.context);
                    filth.merge (templateContext, content);
                } else if (action.config.context) {
                    templateContext = filth.clone (action.config.context);
                    filth.merge (templateContext, content);
                } else
                    templateContext = filth.clone (content);
                // inject authentication information into the context
                templateContext.authentication = agent.export();

                // "substationEvents" boilerplate injects events into template context
                if (events.length) {
                    var eventScript =
                        '<script type="text/javascript">(function(){'
                      + 'var substation=require("substation");substation.sendEvents('
                      + JSON.stringify (events)
                      + ');})()</script>'
                      ;
                    templateContext.SubstationEvents = eventScript;
                }

                if (html)
                    return closeResponse ('200', 'text/html', html);

                action.toHTML (self.parent, status, templateContext, function (err, html) {
                    if (err)
                        return closeResponse (502, 'text/plain', 'rendering error');
                    closeResponse ('200', 'text/html', html);
                });
            }, function (status, stream) {
                self.parent.logger.info ({
                    transport:  actionRequest.transport,
                    format:     actionRequest.format,
                    method:     actionRequest.method,
                    path:       actionRequest.url,
                    action:     action.name,
                    status:     status,
                    latency:    timeDifference (startTime, process.hrtime())
                }, 'action');

                headers = {
                    'Content-Type':     type,
                    'Content-Length':   Buffer.byteLength (msg)
                };
                if (reply.redirectURL)
                    headers.Location = reply.redirectURL;
                if (!streamClosed)
                    headers.Connection = "close";
                response.writeHead (code, headers);
                stream.pipe (response);
            });

            // binary streams
            if (streaming) {
                if (!action.config.binaryStreams) {
                    logger.warn ({
                        url:        request.url,
                        ip:         request.connection.remoteAddress,
                        headers:    request.headers,
                        action:     actionName
                    }, 'streaming request rejected by action');
                    reply.done ('400');
                    return;
                }
                if (!Object.hasOwnProperty.call (request.headers, 'content-type')) {
                    logger.warn ({
                        url:        request.url,
                        ip:         request.connection.remoteAddress,
                        headers:    request.headers,
                        action:     actionName
                    }, 'streaming request without content-type');
                    reply.done ('400');
                    return;
                }

                if (action.route) {
                    var match = action.route.exec (actionRequest.url);
                    if (!match) {
                        logger.warn ({
                            url:        actionRequest.url,
                            ip:         request.connection.remoteAddress,
                            headers:    request.headers,
                            action:     actionName
                        }, 'remote service requested a non-matching url');
                        // close connection with 400
                        return;
                    }
                    actionRequest.params = match.slice (1);
                } else
                    actionRequest.params = [ actionRequest.url ];

                actionRequest.contentType = request.headers['content-type'];
                actionRequest.stream = request;
                actionRequest.url = parsedURL.pathname;
                actionRequest.query = parsedURL.query;
                action.run (self.parent, agent, actionRequest, reply);
                return;
            }

            // non-streaming setup
            actionRequest.url = request.headers['x-substation-url'];

            // cache the request and parse it as JSON
            var total = 0;
            var chunks = [];
            request.on ('data', function (chunk) {
                total += chunk.length;
                if (total <= action.config.maxBodyLength) {
                    chunks.push (chunk);
                    return;
                }

                logger.warn ({
                    url:        request.url,
                    ip:         request.connection.remoteAddress,
                    headers:    request.headers,
                    action:     actionName
                }, 'action exceeded maxLength');
                request.removeAllListeners();
                request.emit ('end');
                reply.done ('413');
            });
            request.on ('end', function(){
                streamClosed = true;
                try {
                    var body = JSON.parse (Buffer.concat (chunks).toString());
                } catch (err) {
                    logger.warn ({
                        url:        request.url,
                        ip:         request.connection.remoteAddress,
                        headers:    request.headers,
                        action:     actionName,
                        bodyLength: total
                    }, 'action body was invalid json');
                    reply.done ('400');
                    return;
                }

                // error rendering requests
                if (request.headers['x-substation-failed']) {
                    reply.content (body);
                    reply.done (request.headers['x-substation-failed']);
                    return;
                }

                if (config.safeRemoteRequests) try {
                    requestBodyValidator.validate (body);
                } catch (err) {
                    logger.warn ({
                        url:        request.url,
                        ip:         request.connection.remoteAddress,
                        headers:    request.headers,
                        action:     actionName,
                        bodyLength: total
                    }, 'action body was an invalid document');
                    reply.done ('400');
                }

                if (body.body)
                    actionRequest.body = body.body;
                if (body.query)
                    actionRequest.query = body.query;
                if (body.params)
                    actionRequest.params = body.params;
                action.run (self.parent, agent, actionRequest, reply);
            });
            request.on ('error', function (err) {
                logger.warn ({
                    url:        request.url,
                    ip:         request.connection.remoteAddress,
                    headers:    request.headers,
                    action:     actionName
                }, 'action failed to send body');
            });
        });
    });
    rpcServer.listen (port, callback);
};
