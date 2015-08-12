
var util         = require ('util');
var fs           = require ('fs');
var path         = require ('path');
var EventEmitter = require ('events').EventEmitter;
var async        = require ('async');
var filth        = require ('filth');

var submergence  = require ('submergence');
var Reply = submergence.Reply;

var Remote       = require ('./remote');
var Router       = require ('./lib/Router');
var Action       = require ('./lib/Action');

// pull in extra docs automatically
require ('./info.js');

var standalone =
    '<script type="text/javascript">'
  + fs.readFileSync (path.resolve (__dirname, './build/bundle.js')).toString()
  + '</script>'
  ;


/**     @module/class substation
    @super submergence
    Realtime application gateway and authentication provider. This is the all-purpose module for
    writing client applications over the [submergence](submergence) layer. You may serve an
    application from a local cluster or respond to events forwarded from a submergence service. To
    access the client library, bundle this module with [browserify](http://browserify.org/).

    A `substation` always represents a single domain (or subdomain) which must [appear in the
    configuration](:Configuration#domain).
@spare details
    @load `README.md`
@argument/:Configuration config
    Configuration options to use for this instance.
@returns/substation
    If the `new` keyword is not used, an instance is created and returned.
*/
function substation (config) {
    if (!(this instanceof substation))
        return new substation (config);
    EventEmitter.call (this);

    this.config = filth.clone (DEFAULT_CONFIG);
    filth.merge (this.config, config);

    this.server = new submergence (this.config);
    this.router = new Router (this, this.config);
    this.logger = this.server.logger;
}
// util.inherits (substation, EventEmitter);
substation.Remote = Remote;


/**     @submodule/class Configuration
    @super submergence:Configuration
@member/String databaseName
    @default `"substation"`
@member/String applicationName
    @default `"substation"`
@member/Object context
    Sets default values for html template rendering operations. The render context will be a deep
    clone of `context` merged with the `content` context generated by an Action.
@member/Object template
*/
var DEFAULT_CONFIG = {
    databaseName:           "substation",
    applicationName:        "substation",
    context:                {
        standalone:             standalone
    }
};


/**     @member/Function listen
    Initializes the [Router](:Router), then opens inbound sockets. Every [Action](:Action) will
    have its [setup](:Action:Configuration#setup) Function called **before** any requests are
    accepted.
@argument/Number port
    The port number to listen on.
@callback
    The server is now accepting requests. If something prevents this, the process will exit with
    status code `1`.
*/
substation.prototype.listen = function (port, callback) {
    if (!this.config.domain) {
        logger.fatal ('domain not configured');
        return process.exit (1);
    }

    var self = this;
    this.router.init (function(){
        self.server.listen (port, self.router, callback);
    });
}


/**     @member/Function addAction
    @alias :Router#addAction
@callback
    @argument/Error|undefined err
*/
substation.prototype.addAction = function(){
    return this.router.addAction.apply (this.router, arguments);
}


/**     @member/Function sendEvent

@argument/String user
@argument/String client
    @optional
@argument/Object info
@callback
    @optional
*/
substation.prototype.sendEvent = function (/* user, client, info, callback */) {
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

    try {
        return this.server.sendEvent (this.config.domain || null, user, client, info, callback);
    } catch (err) {
        self.logger.error (err, 'failed to send event');
        if (callback)
            process.nextTick (callback);
    }
};


/**     @member/Function isActive

@argument/String user
@argument/String client
    @optional
@callback
    @argument/Error|undefined err
    @argument/Boolean isActive
*/
substation.prototype.isActive = function (/* user, client, callback */) {
    var user, client, callback;
    if (arguments.length == 2) {
        user = arguments[0];
        callback = arguments[1];
    } else {
        user = arguments[0];
        client = arguments[1];
        callback = arguments[2];
    }

    try {
        return this.server.isActive (this.config.domain || null, user, client, callback);
    } catch (err) {
        this.logger.error (err, 'failed to check if a user/client is active');
        if (callback)
            process.nextTick (function(){ callback (err); });
    }
};


/**     @member/Function action
    Trigger an [Action](substation:Action) in JSON mode and get the resulting content and events,
    or a [stream](stream.Readable) if the Action produces one. Any manually-produced html is
    ignored.

    There is no method to run an [Action](substation:Action) in HTML mode because an Action's
    template should generate a complete page.
@argument/submergence:Agent
@argument/substation:Action
@argument/submergence:Request
@callback
    @argument/Error|undefined err
    @argument/String status
    @argument/Object|stream.Readable content
        The 'content' value produced by the selected Action.
    @argument/Array<Array> events
    @argument/Number length
        @optional
        If a Stream was returned, its length will be passed.
    @argument/String type
        @optional
        If a Stream was returned and a type was defined, it will be passed.
*/
substation.prototype.action = function (agent, action, request, callback) {
    this.router.getActionByName (action, function (err, action) {
        if (err) return callback (err);
        var reply = new Reply (function (status, events, content, html) {
            callback (undefined, status, content, events);
        }, function (status, stream, length, type) {
            callback (undefined, status, stream, events, length, type);
        });
    });
};


// proxy events:EventEmitter methods to underlying submergence
substation.prototype.addListener = function(){
    this.server.addListener.apply (this.server, arguments);
};
substation.prototype.on = function(){
    this.server.on.apply (this.server, arguments);
};
substation.prototype.once = function(){
    this.server.once.apply (this.server, arguments);
};
substation.prototype.removeListener = function(){
    this.server.removeListener.apply (this.server, arguments);
};
substation.prototype.removeAllListeners = function(){
    this.server.removeAllListeners.apply (this.server, arguments);
};
substation.prototype.setMaxListeners = function(){
    this.server.setMaxListeners.apply (this.server, arguments);
};
substation.prototype.listeners = function(){
    this.server.listeners.apply (this.server, arguments);
};


/**     @property/Function configure
    Set configuration options for `substation` as a monad. You may call configure multiple times to
    assemble configuration options - in case of conflict, the most recent configuration wins.

    You may still instantiate `substation` instances after configuring and starting the monad. They
    will **not** inherit configuration options or Actions from the monad.
@argument/:Configuration config
*/
var monadConfig, monad;
function configure (config) {
    if (monad)
        throw new Error ('cannot configure as a monad when already listening as a monad');
    if (!monadConfig)
        monadConfig = filth.clone (config);
    else
        filth.merge (monadConfig, config);
}


/**     @property/Function listen

@argument/Number port
@callback
    @argument/Error|undefined err
*/
function monadListen (port, callback) {
    if (!monad)
        if (monadConfig.APIKey)
            monad = new Remote (monadConfig);
        else
            monad = new substation (monadConfig);
    for (var i=0,j=actionQueue.length; i<j; i++)
        monad.addAction.apply (monad, actionQueue[i]);
    for (var i=0,j=monadQueue.length; i<j; i++)
        monad[monadQueue[i][0]].apply (monad, monadQueue[i][1]);
    return monad.listen (port, callback);
}


/**     @property/Function addAction

@argument/String method
    @optional
@argument/String|RegExp route
    @optional
@argument/substation:Action action
*/
var actionQueue = [];
var monadQueue = [];
function addAction (method, route, action) {
    if (monad)
        return monad.addAction (method, route, action);
    actionQueue.push ([ method, route, action ]);
}


/**     @property/Function sendEvent

*/
function sendEvent(){
    return monad.sendEvent.apply (monad, arguments);
};


/**     @property/Function isActive

*/
function isActive(){
    return monad.isActive.apply (monad, arguments);
};


// proxy events:EventEmitter methods to underlying submergence
substation.addListener = function(){
    if (!monad) {
        monadQueue.push ('addListener', arguments);
        return;
    }
    monad.addListener.apply (monad, arguments);
};
substation.on = function(){
    if (!monad) {
        monadQueue.push ('on', arguments);
        return;
    }
    monad.on.apply (monad, arguments);
};
substation.once = function(){
    if (!monad) {
        monadQueue.push ('once', arguments);
        return;
    }
    monad.once.apply (monad, arguments);
};
substation.removeListener = function(){
    if (!monad) {
        monadQueue.push ('removeListener', arguments);
        return;
    }
    monad.removeListener.apply (monad, arguments);
};
substation.removeAllListeners = function(){
    if (!monad) {
        monadQueue.push ('removeAllListeners', arguments);
        return;
    }
    monad.removeAllListeners.apply (monad, arguments);
};
substation.setMaxListeners = function(){
    if (!monad) {
        monadQueue.push ('setMaxListeners', arguments);
        return;
    }
    monad.setMaxListeners.apply (monad, arguments);
};
substation.listeners = function(){
    if (!monad) {
        monadQueue.push ('listeners', arguments);
        return;
    }
    monad.listeners.apply (monad, arguments);
};

module.exports = substation;
substation.configure = configure;
substation.listen = monadListen;

substation.Action = Action;
substation.Router = Router;
