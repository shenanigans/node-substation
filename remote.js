
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
    @super events.EventEmitter
    Realtime application gateway and authentication provider. You may either instantiate or use this
    module as a monad.
@argument/.Configuration config
@returns/substation:Remote
    If the `new` keyword is not used, an instance is created and returned.
@event userOnline
@event clientOnline
@event userOffline
@event clientOffline
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

/**     @member/Function addAction

*/
Remote.prototype.addAction = function(){
    return this.router.addAction.apply (this.router, arguments);
};

/**     @member/Function listen

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
                                    'remote service rejected configuration as invalid'
                                );
                            else if (response.statusCode == '403')
                                self.logger.fatal ('remote service rejected the APIKey');
                            else
                                self.logger.fatal ('unknown remote service error');
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
