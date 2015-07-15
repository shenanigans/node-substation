
var http = require ('http');
var crypto = require ('crypto');
var filth = require ('filth');
var likeness = require ('likeness');
var RemoteAgent = require ('./RemoteAgent');
var Reply = require ('submergence').Reply;

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
function RemoteTransport (config, logger) {
    this.config = config;
    this.logger = logger;
}

/**     @member/Function listen

*/
RemoteTransport.prototype.listen = function (port, router, callback) {
    if (!this.config.APIKey)
        return this.logger.fatal ('API Key not configured');

    var hasher = crypto.createHash ('sha256');
    hasher.update (this.config.APIKey);
    var expectedKey = hasher.digest ('base64');
    var requestHeadersValidator = new likeness ({
        '.arbitrary':               true,
        'x-substation-action':      {
            '.type':        'string',
            '.maxLength':   192
            '.error':       'x-substation-action'
        },
        'x-substation-url':      {
            '.description': 'Only contains GET params when streaming requests are used.'
            '.type':        'string',
            '.maxLength':   256
            '.error':       'x-substation-url'
        },
        'x-substation-key':         {
            '.type':        'string',
            '.value':       expectedKey,
            '.error':       'x-substation-key'
        },
        'x-substation-transport':   {
            '.type':        'string',
            '.anyValue':    [ 'http', 'socket.io' ],
            '.error':       'x-substation-transport'
        },
        'x-substation-format':      {
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
        }
    });

    var logger = this.logger;
    var config = this.config;
    var rpcServer = http.createServer (function (request, response) {
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

        var agent = new RemoteAgent (
            config,
            request.headers['x-substation-user'] || '',
            request.headers['x-substation-client'] || '',
            Boolean (request.headers['x-substation-active']),
            Boolean (request.headers['x-substation-domestic'])
        );
        var actionRequest = {
            url:        request.headers['x-substation-url']
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

        router.getActionByName (request.headers['x-substation-action'], function (err, action) {
            if (err) {
                logger.error ({ action:actionName, err:err }, 'action routing error');
                // close connection with 502
                return;
            }

            if (!action) {
                logger.warn ({
                    url:        actionRequest.url,
                    ip:         actionRequest.connection.remoteAddress,
                    headers:    actionRequest.headers,
                    action:     actionName
                }, 'unknown action requested');
                // close connection with 404
                return;
            }

            var reply = new Reply (function (status, events, content, html) {
                // every future ending point from here uses this function to close the response
                function closeResponse (code, type, msg) {
                    station.logger.info ({
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
                        'Content-Length':   Buffer.byteLength (msg)
                    };
                    if (reply.redirectURL)
                        headers.Location = reply.redirectURL;
                    if (!streamClosed)
                        headers.Connection = "close";

                    response.writeHead (code, headers);
                    response.end (msg);
                }

                if (actionRequest.format == 'json' || !action.template)
                    return closeResponse (
                        status,
                        'application/json; charset=utf-8',
                        JSON.stringify ({ events:events, content:content })
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
                    return closeResponse (status, 'text/html', html);

                action.toHTML (station, status, templateContext, function (err, html) {
                    if (err)
                        return rejectRequest (502, 'rendering error');
                    closeResponse (status, 'text/html', html);
                });
            }, function (status, stream) {
                station.logger.info ({
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

                actionRequest.contentType = request.headers['content-type'];
                actionRequest.stream = request;
                actionRequest.url = parsedURL.pathname;
                actionRequest.query = parsedURL.query;
                action.run (station, agent, actionRequest, reply);
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
                try {
                    var body = JSON.parse (Buffer.concat (chunks));
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
                action.run (station, agent, actionRequest, reply);
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
