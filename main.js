
var util         = require ('util');
var EventEmitter = require ('events').EventEmitter;
var bunyan       = require ('bunyan');
var async        = require ('async');
var MongoDB      = require ('mongodb');
var Common       = require ('./lib/Common');
var Transport    = require ('./lib/Transport');
var Router       = require ('./lib/Router');
var Backplane    = require ('./lib/Backplane');
var Action       = require ('./lib/Action');

/**     @struct substation.Configuration

@member/String databaseName
    @default `"substation"`
@member/String databaseAddress
    @default `"127.0.0.1"`
@member/Number databasePort
    @default `27017`
@member/.Authentication.Configuration Authentication
@member/.Backplane.Configuration Backplane
*/
var DEFAULT_CONFIG = {
    port:                   80,
    allowForeignSockets:    true,
    binaryStreams:          false,
    bufferFiles:            64000,
    databaseName:           'substation',
    databaseAddress:        '127.0.0.1',
    databasePort:           27017,
    sessionCollectionName:  'Session',
    LinksCollectionName:    "Links",
    loggingLevel:           "info",
    applicationName:        "substation",
    Authentication:         {
        cacheSessions:          100000,
        sessionsCollectionName: 'Sessions',
        sessionCacheTimeout:    1000 * 60 * 30, // thirty minutes
        sessionLifespan:        1000 * 60 * 60 * 24, // one day
        sessionRenewalTimeout:  1000 * 60 * 60 * 24 * 3, // three days
        loginLifespan:          1000 * 60 * 60 * 24 * 7 * 2, // two weeks
        cookieLifespan:         1000 * 60 * 60 * 24 * 365 // one year
    },
    Backplane:              {
        port:                   9001,
        collectionName:         'Backplane',
        hostsCollectionName:    'BackplaneHosts',
        cacheLinks:             20480,
        linkCacheTimeout:       1000 * 60 * 5 // five minutes
    }
};


/**     @module/class substation
    @parent events.EventEmitter
    Realtime application gateway and authentication provider. You may either instantiate or use this
    module as a monad.
@event userOnline
@event clientOnline
@event userOffline
@event clientOffline
@argument/.Configuration config
@returns/substation
    If the `new` keyword is not used, an instance is created and returned.
*/
function substation (config) {
    if (!(this instanceof substation))
        return new substation (config);
    EventEmitter.call (this);

    this.config = Common.clone (DEFAULT_CONFIG);
    Common.merge (this.config, config);
    this.logger = new bunyan ({
        name:   this.config.applicationName,
        stream: process.stdout,
        level:  this.config.loggingLevel
    });

    this.router = new Router (this, this.config);
    this.transport = new Transport (this, this.config);
    this.backplane = new Backplane (this, this.config.Backplane);
}
util.inherits (substation, EventEmitter);


/**     @member/Function listen
@callback
    @argument/Error|undefined err
*/
var COLLECTIONS = [ 'Sessions', 'Backplane' ];
substation.prototype.listen = function (callback) {
    var config = this.config;
    var router = this.router;
    var transport = this.transport;
    var backplane = this.backplane;

    if (config.SessionsCollection && config.BackplaneCollection) {
        this.SessionsCollection = config.SessionsCollection;
        this.BackplaneCollection = config.BackplaneCollection;
        return async.parallel ([
            function (callback) {
                backplane.init (callback);
            },
            function (callback) {
                router.init (callback);
            }
        ], function (err) {
            transport.listen (callback);
        });
    }

    var Database = new MongoDB.Db (
        config.databaseName,
        new MongoDB.Server (config.databaseAddress, config.databasePort),
        { w:'majority', journal:true }
    );
    var self = this;
    Database.open (function (err) {
        if (err) {
            self.logger.fatal (err);
            return process.exit (1);
        }

        async.parallel ([
            function (callback) {
                if (config.SessionsCollection) {
                    self.SessionsCollection = config.SessionsCollection;
                    return callback();
                }
                Database.collection (config.sessionCollectionName, function (err, collection) {
                    if (err) {
                        self.logger.fatal (err);
                        return process.exit (1);
                    }
                    self.SessionsCollection = collection;
                    callback();
                });
            },
            function (callback) {
                if (config.Backplane.Collection) {
                    self.BackplaneCollection = config.Backplane.Collection;
                    return callback();
                }
                Database.collection (config.Backplane.collectionName, function (err, collection) {
                    if (err) {
                        self.logger.fatal (err);
                        return process.exit (1);
                    }
                    self.BackplaneCollection = collection;
                    callback();
                });
            },
            function (callback) {
                if (config.Backplane.HostsCollection) {
                    self.BackplaneHostsCollection = config.Backplane.HostsCollection;
                    return callback();
                }
                Database.collection (config.Backplane.hostsCollectionName, function (err, collection) {
                    if (err) {
                        self.logger.fatal (err);
                        return process.exit (1);
                    }
                    self.BackplaneHostsCollection = collection;
                    callback();
                });
            },
            function (callback) {
                if (config.LinksCollection) {
                    self.LinksCollection = config.LinksCollection;
                    return callback();
                }
                Database.collection (config.LinksCollectionName, function (err, collection) {
                    if (err) {
                        self.logger.fatal (err);
                        return process.exit (1);
                    }
                    self.LinksCollection = collection;
                    callback();
                });
            }
        ], function(){
            async.parallel ([
                function (callback) {
                    backplane.init (callback);
                },
                function (callback) {
                    router.init (callback);
                }
            ], function (err) {
                transport.listen (function (err) {
                    if (err) {
                        self.logger.fatal (err);
                        return process.exit (1);
                    }

                    callback();
                });
            });
        });
    });
}


/**     @member/Function addAction
@callback
    @argument/Error|undefined err
*/
substation.prototype.addAction = function(){
    return this.router.addAction.apply (this.router, arguments);
}


/**     @member/Function sendEvent

*/
substation.prototype.sendEvent = function(/* user, client, info, callback */){
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

    try {
        return this.backplane.sendEvent (user, client, info, callback);
    } catch (err) {
        self.logger.error ({ method:"sendEvent" }, err);
        if (callback)
            process.nextTick (callback);
    }
};


/**     @member/Function isActive

*/
substation.prototype.isActive = function(){
    return this.backplane.isActive.apply (this.backplane, arguments);
};


/**     @property/Function configure
    Set configuration options for `substation` as a monad. You may call configure multiple times to
    assemble configuration options - in case of conflict, the most recent configuration wins.

    You may still instantiate `substation` instances after configuring and starting the monad. They
    will **not** inherit configuration options or Actions from the monad.
@argument/.Configuration config
*/
var monadConfig, monad;
function configure (config) {
    if (monad)
        throw new Error ('cannot configure as a monad when already listening as a monad');
    if (!monadConfig)
        monadConfig = Common.clone (config);
    else
        Common.merge (monadConfig, config);
}


/**     @property/Function listen

@callback
    @argument/Error|undefined err
*/
function monadListen (callback) {
    if (!monad)
        monad = new substation (monadConfig);
    if (actionQueue)
        for (var i=0,j=actionQueue.length; i<j; i++)
            monad.addAction.apply (monad, actionQueue[i]);
    return monad.listen (callback);
}


/**     @property/Function addAction

*/
var actionQueue;
function addAction (method, route, action) {
    if (monad)
        return monad.addAction (method, route, action);
    if (!actionQueue)
        actionQueue = [ [ method, route, action ] ];
    else
        actionQueue.push ([ method, route, action ]);
}


/**     @property/Function sendEvent

*/
function sendEvent(){
    return monad.backplane.sendEvent.apply (monad, arguments);
};


/**     @property/Function isActive

*/
function isActive(){
    return monad.backplane.isActive.apply (this.backplane, arguments);
};


module.exports = substation;
substation.configure = configure;
substation.listen = monadListen;

substation.Action = Action;
