
var util            = require ('util');
var fs              = require ('fs');
var path            = require ('path');
var EventEmitter    = require ('events').EventEmitter;
var https           = require ('https');
var http            = require ('http');
var bunyan          = require ('bunyan');
var async           = require ('async');
var filth           = require ('filth');
var RemoteTransport = require ('./lib/RemoteTransport');

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
    this.server = new RemoteTransport (config, this.logger);
    this.router = new Router (this, this.config);

    if (
        !this.config.APIKey
     || !this.config.APIHost
    )
        throw new Error ('APIKey and APIHost are required');
}
util.inherits (Remote, EventEmitter);

/**     @member/Function addAction

*/
Remote.prototype.addAction = function(){
    return this.router.addAction.apply (this.router, arguments);
};

/**     @member/Function listen

*/
Remote.prototype.listen = function (port, callback) {
    var self = this;

    // we must check the remote configuration and optionally overwrite it
    var pathstr =
        '/config?apiKey='
      + this.config.APIKey
      + '&domain='
      + this.config.domain
      ;
    var eventRequest = http.request ({
        host:   this.config.APIHost,
        path:   pathstr,
        method: 'POST'
    }, function (response) {
        var chunks = [];
        response.on ('data', function (chunk) { chunks.push (chunk); });
        response.on ('error', function (err) {
            self.logger.fatal (err, 'could not pull a configuration from the remote service');
        });
        response.on ('end', function(){
            try {
                var body = JSON.parse (Buffer.concat (chunks).toString());
            } catch (err) {
                if (callback)
                    return self.logger.fatal ('remote service response was invalid JSON');
                return;
            }

        });
    });

    this.router.init (function(){
        self.server.listen (port, self.router, callback);
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
      + '&user='
      + encodeURIComponent (user)
      ;
    if (client)
        pathstr += '&client=' + encodeURIComponent (client);
    var eventRequest = http.request ({
        host:   this.config.APIHost,
        path:   pathstr,
        method: 'POST'
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
    eventRequest.write (JSON.stringify (info));
    eventRequest.end();
};

/**     @member/Function isActive

*/
Remote.prototype.isActive = function (/* user, client, callback */){
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
    eventRequest.write (JSON.stringify (info));
    eventRequest.end();
};
