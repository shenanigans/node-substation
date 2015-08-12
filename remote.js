
var util            = require ('util');
var fs              = require ('fs');
var path            = require ('path');
var EventEmitter    = require ('events').EventEmitter;
var https           = require ('https');
var http            = require ('http');
var os              = require ('os');
var bunyan          = require ('bunyan');
var async           = require ('async');
var filth           = require ('filth');
var RemoteTransport = require ('./lib/RemoteTransport');
var Router          = require ('./lib/Router');
var DEFAULT_CONFIG  = require ('submergence').DEFAULT_CONFIG;

var standalone =
    '<script type="text/javascript">'
  + fs.readFileSync (path.resolve (__dirname, './build/bundle.js')).toString()
  + '</script>'
  ;


/**     @module/class substation:Remote
    @super submergence
    Instantiate a `Remote` to connect to a [submergence]() service layer hosted on another cluster.
    If you use the normal [substation]() module as a monad and your config includes the [APIKey]
    (:Configuration#APIKey) and [APIForward]((:Configuration#APIForward) keys you will get a
    `Remote` automatically.
@argument/substation:Configuration config
@returns/substation:Remote
    If the `new` keyword is not used, an instance is created and returned.
*/
function Remote (config) {
    if (!(this instanceof Remote))
        return new Remote (config);
    EventEmitter.call (this);
    this.config = filth.clone (DEFAULT_CONFIG);
    filth.merge (this.config, config);

    this.logger = new bunyan ({
        name:   this.config.applicationName,
        stream: process.stdout,
        level:  this.config.loggingLevel
    });
    this.server = new RemoteTransport (config, this);
    this.router = new Router (this, this.config);

    if (
        !this.config.APIKey
     || !this.config.APIHost
    )
        throw new Error ('APIKey and APIHost are required');
}
util.inherits (Remote, EventEmitter);
module.exports = Remote;


Remote.prototype.addAction = function(){
    return this.router.addAction.apply (this.router, arguments);
};


/**     @member/Function listen
    Reads the remote configuration and compares it to the local instance. If the remote
    configuration does not match, the `Remote` will do one of the following:
     * By default, the process will exit.
     * If the [APIOverwriteActions](:Configuration#APIOverwriteActions) option is set, the local
        configuration is written to the server. If this fails for some reason, the process will
        exit.
     * If the [APIAcceptConfig](:Configuration#APIAcceptConfig) option is set, the discrepency is
        logged but startup continues.

    Once the remote configuration is resolved, [actions](substation:Action) have their [setup]
    (substation:Action:Configuration#setup) Functions run. Finally, the port is opened and  this
    `Remote` begins accepting requests.
@argument/Number port
    The port number to listen on.
@callback
    The server is now accepting requests. If something prevents this, the process will exit with
    status code `1`.
*/
var SERVER_EVENTS = [
    'userOnline', 'userOffline', 'clientOnline', 'clientOffline', 'peerRequest', 'liveConnection'
];
Remote.prototype.listen = function (port, callback) {
    var self = this;

    // setup the API forwarding information for this node
    // unless already configured
    if (!this.config.APIForward)
        this.config.APIForward = {
            host:   os.hostname(),
            port:   port
        };

    this.router.init (function(){
        function cleanup (err) {
            if (err)
                return self.logger.fatal (err);
            self.server.listen (port, self.router, callback);
        }

        var localConfig = { events:{} };
        for (var i=0,j=SERVER_EVENTS.length; i<j; i++) {
            var event = SERVER_EVENTS[i];
            if (self.listeners (event).length)
                localConfig.events[event] = filth.clone (self.config.APIForward);
        }

        // we must check the remote configuration and optionally overwrite it
        var pathstr =
            '/config?apiKey='
          + encodeURIComponent (self.config.APIKey)
          + '&domain='
          + encodeURIComponent (self.config.domain)
          ;
        var configRequest = http.request ({
            host:       self.config.APIHost,
            path:       pathstr,
            method:     'GET',
            headers:    {
                Accept:     'application/json'
            }
        }, function (response) {
            var chunks = [];
            response.on ('data', function (chunk) { chunks.push (chunk); });
            response.on ('error', function (err) {
                self.logger.fatal (err, 'could not pull a configuration from the remote service');
            });
            response.on ('end', function(){
                try {
                    var currentConfig = JSON.parse (Buffer.concat (chunks).toString());
                } catch (err) {
                    self.logger.fatal ('remote service response was invalid JSON');
                    return;
                }
                currentConfig = currentConfig.content;
                var configID = currentConfig._id;
                delete currentConfig._id;

                self.router.getAllActions (function (err, actions) {
                    if (err)
                        return self.logger.fatal (err);

                    localConfig.actions = actions.map (function (item) {
                        var actionDoc = item.export();
                        actionDoc.forward = filth.clone (self.config.APIForward);
                        return actionDoc;
                    });

                    if (filth.compare (localConfig, currentConfig)) {
                        self.logger.info ('remote configuration matches');
                        return cleanup();
                    }

                    if (!self.config.APIOverwriteActions) {
                        self.logger.fatal (
                            'remote service configuration does not match local server'
                        );
                        return process.exit (1);
                    }

                    var pathstr =
                        '/config/'
                      + encodeURIComponent (configID)
                      + '?apiKey='
                      + encodeURIComponent (self.config.APIKey)
                      ;
                    var localConfigStr = JSON.stringify (localConfig);
                    var configWriteRequest = http.request ({
                        host:       self.config.APIHost,
                        path:       pathstr,
                        method:     'PUT',
                        headers:    {
                            Accept:             'application/json',
                            'Content-Length':   Buffer.byteLength (localConfigStr)
                        }
                    }, function (response) {
                        if (response.statusCode == '200') {
                            // config written successfully
                            response.removeAllListeners();
                            response.emit ('end');
                            cleanup();
                            return;
                        }

                        var chunks = [];
                        response.on ('data', function (chunk) { chunks.push (chunk); });
                        response.on ('error', function (err) {
                            self.logger.fatal (err, 'failed to write config to remote service');
                            return process.exit (1);
                        });
                        response.on ('end', function(){
                            try {
                                var responseBody = JSON.parse (Buffer.concat (chunks).toString());
                            } catch (err) {
                                self.logger.fatal ('remote service responded with invalid json');
                                return process.exit (1);
                            }

                            if (response.statusCode == '400')
                                self.logger.fatal (
                                    responseBody,
                                    'remote service rejected configuration as invalid'
                                );
                            else if (response.statusCode == '403')
                                self.logger.fatal (
                                    responseBody,
                                    'remote service rejected the APIKey'
                                );
                            else
                                self.logger.fatal (
                                    responseBody,
                                    'unknown remote service error'
                                );
                            return process.exit (1);
                        });
                    });
                    configWriteRequest.on ('error', function (err) {
                        self.logger.fatal (err, 'failed to update remote configuration');
                        return process.exit (1);
                    });
                    configWriteRequest.write (localConfigStr);
                    configWriteRequest.end();
                });
            });
        });

        configRequest.on ('error', function (err) {
            self.logger.fatal (err, 'failed to read remote configuration');
            return process.exit (1);
        });
        configRequest.end();

    });
};


/**     @member/Function sendEvent
    Send an event to a User or User/Client pair with at least one active `Socket.io` connection.
    These are best-effort events - delivery will not be ensured, just attempted. Messages with
    ensured delivery must be handled in the application. Guaranteed delivery like `substation` could
    provide is of limited value because it only guarantees that the message arrived, not that it was
    successfully acted upon.

    Makes an http `POST` request against the remote service on the path `/event`.
@argument/String user
    Send events to connections with this User ID.
@argument/String client
    @optional
    If present, narrows the User ID selection to this specific User/Client pair.
@argument/Array info
    The argument parameters as they will appear on the client, beginning with the String name of the
    event to emit.
@callback
    @optional
    @argument/Error|undefined err
        If a technical Error prevented the attempt for proceeding, it is passed here.
    @argument/Boolean didReceive
        Whether a client is expected to receive the event. This result value is produced early,
        after connections have been found but before any data has been sent. It is possible, though
        unlikely, that one of the selected connections will go offline in the next fistfull of
        milliseconds, resulting in a `true` for `didReceive` when no events were in fact delivered.
*/
Remote.prototype.sendEvent = function (/* user, client, info, callback */) {
    var user, client, info, callback;
    switch (arguments.length) {
        case 2:
            user = arguments[0];
            info = arguments[1];
            break;
        case 3:
            user = arguments[0];
            info = arguments[1];
            callback = arguments[2];
            break;
        default:
            user = arguments[0];
            client = arguments[1]
            info = arguments[2];
            callback = arguments[3];
    }

    if (typeof info[0] != 'string')
        return process.nextTick (function(){ callback (
            new Error ('First event argument must be a string')
        ); });

    var pathstr =
        '/event?apiKey='
      + encodeURIComponent (this.config.APIKey)
      + '&domain='
      + encodeURIComponent (this.config.domain)
      + '&user='
      + encodeURIComponent (user)
      ;
    if (client)
        pathstr += '&client=' + encodeURIComponent (client);
    var infoStr = JSON.stringify (info);
    var eventRequest = http.request ({
        host:       this.config.APIHost,
        path:       pathstr,
        method:     'POST',
        headers:    {
            Accept:             'application/json',
            'Content-Length':   Buffer.byteLength (infoStr)
        }
    }, function (response) {
        var chunks = [];
        response.on ('data', function (chunk) { chunks.push (chunk); });
        response.on ('error', function (err) {
            if (callback)
                callback (err);
        });
        response.on ('end', function(){
            try {
                var body = JSON.parse (Buffer.concat (chunks).toString());
            } catch (err) {
                if (callback)
                    return callback (new Error ('remote service response was invalid JSON'));
                return;
            }
            if (response.statusCode == '200') {
               if (callback)
                    callback (undefined, Boolean (body));
            } else
                if (callback)
                    callback (body);
        });
    });
    eventRequest.on ('error', function (err) {
        if (callback)
            callback (err);
    });
    eventRequest.write (infoStr);
    eventRequest.end();
};


/**     @member/Function isActive
    Check for an active `Socket.io` connection belonging to a User or User/Client pair. Makes an
    http `GET` request against the remote service on the path `/session`.
@argument/String user
    The user to look for.
@argument/String client
    @optional
    Only include connections belonging to this specific client.
@callback
    @argument/Error|undefined
        If a technical Error prevented the attempt for proceeding, it is passed here.
    @argument/Boolean isActive
        Whether one or more connections exist for the named User or User/Client pair.
*/
Remote.prototype.isActive = function (/* user, client, callback */) {
    var user, client, callback;
    switch (arguments.length) {
        case 2:
            user = arguments[0];
            callback = arguments[1];
            break;
        default:
            user = arguments[0];
            client = arguments[1]
            callback = arguments[2];
    }

    var pathstr =
        '/session?apiKey='
      + encodeURIComponent (this.config.APIKey)
      + '&domain='
      + encodeURIComponent (this.config.domain)
      + '&user='
      + encodeURIComponent (user)
      ;
    if (client)
        pathstr += '&client=' + encodeURIComponent (client);
    var eventRequest = http.request ({
        host:   this.config.APIHost,
        path:   pathstr
    }, function (response) {
        if (response.statusCode == '200') {
            callback (undefined, true);
            response.emit ('end');
            return;
        }
        if (response.statusCode == '204') {
            callback (undefined, false);
            response.emit ('end');
            return;
        }
        var chunks = [];
        response.on ('data', function (chunk) { chunks.push (chunk); });
        response.on ('error', callback);
        response.on ('end', function(){
            try {
                var body = JSON.parse (Buffer.concat (chunks).toString());
            } catch (err) {
                callback (new Error ('remote service response was invalid JSON'));
                return;
            }
            return callback (undefined, Boolean (body.didRecieve));
        });
    });
    eventRequest.on ('error', function (err) {
        if (callback)
            callback (err);
    });
    eventRequest.end();
};
