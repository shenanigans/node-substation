
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


module.exports = core;
