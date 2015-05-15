
var Server = require ('./browser/Server');
var EventEmitter = require ('events').EventEmitter;
var url = require ('url');

/**     @module substation
    @super EventEmitter
    Realtime application gateway and authentication provider.
*/
var core = new EventEmitter();


/**     @property/Function getServer

@argument/String path
@returns/substation.Server server
*/
var servers = {};
function getServer (path, options) {
    var host = path ? url.parse (path) : window.location;
    if (!host) throw new Error ('invalid url');
    if (Object.hasOwnProperty.call (servers, host)) {
        var server = servers[host];
        if (options)
            server.updateOptions (options);
        return server;
    }
    return servers[host] = new Server (core, host, options);
}
core.getServer = getServer;


/**     @property/Function sendEvents
    Fire an Array of events from the module Object and this domain's Server instance, if it already
    exists.
*/
function sendEvents (events) {
    if (!this.isReady) {
        (this.eventQueue || (this.eventQueue = [])).push.apply (this.eventQueue, events);
        return;
    }
    for (var i=0,j=events.length; i<j; i++)
        core.emit.apply (core, events[i]);
}
core.sendEvents = sendEvents;


/**     @property/Function ready
    Begin firing events. Events will *not* be emitted until this Function is called.
*/
var eventQueue, isReady = false;
function ready(){
    if (!isReady && eventQueue) {
        var queue = eventQueue;
        window.setTimeout (function(){
            for (var i=0,j=queue.length; i<j; i++)
                queue[i]
        }, 1);
        delete eventQueue;
    }
    this.isReady = true;
}
core.ready = ready;


/**     @property/Function inherit
    There are two big issues with `util.inherits`: It won't work with IE <9 and you have to bundle
    the entire `util` package to get it. This version works around both issues.
@argument/Function child
@argument/Function parent
*/
core.inherit = require ('./browser/inherit');


/**     @property/events.EventEmitter otherTabs
    @super events.EventEmitter
    Emit events from the `otherTabs` Object in other tabs.
*/
window.otherTabs = {
    emitter:            new EventEmitter(),
    addListener:        function(){
        this.emitter.addListener.apply (this.emitter, arguments);
    },
    on:                 function(){
        this.emitter.on.apply (this.emitter, arguments);
    },
    once:               function(){
        this.emitter.once.apply (this.emitter, arguments);
    },
    removeListener:     function(){
        this.emitter.removeListener.apply (this.emitter, arguments);
    },
    removeAllListeners: function(){
        this.emitter.removeAllListeners.apply (this.emitter, arguments);
    },
    setMaxListeners:    function(){
        this.emitter.setMaxListeners.apply (this.emitter, arguments);
    },
    listeners:          function(){
        this.emitter.listeners.apply (this.emitter, arguments);
    },
    emit:               function(){
        var info = Array.prototype.slice.call (arguments);
        window.localStorage.setItem ('__substation_event', JSON.stringify (info));
    }
};
window.addEventListener ('storage', function (event) {
    if (event.key != '__substation_event') return;
    window.otherTabs.emitter.emit.apply (otherTabs.emitter, JSON.parse (event.newValue));
});


module.exports = core;
