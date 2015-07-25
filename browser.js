
var Server = require ('./browser/Server');
var MultimediaStream = require ('./browser/MultimediaStream');
var EventEmitter = require ('events').EventEmitter;
var url = require ('url');

/**     @module substation
    @super EventEmitter
    Realtime application gateway and authentication provider.
*/
var core = new EventEmitter();
module.exports = core;
core.MultimediaStream = MultimediaStream;
core.getUserMedia = MultimediaStream.getUserMedia;

/**     @property/Function emit

*/
core.emit = function (eventName) {
    if (this.listeners (eventName).length)
        return EventEmitter.prototype.emit.apply (this, arguments);
    if (Object.hasOwnProperty.call (eventQueue, eventName))
        eventQueue[eventName].push (arguments);
    else
        eventQueue[eventName] = [ arguments ];
};
core.on ('newListener', function (event, listener) {
    if (!Object.hasOwnProperty.call (eventQueue, event))
        return;

    var queue = eventQueue[event];
    delete eventQueue[event];
    var i=0, j=queue.length;
    process.nextTick (function queueStep(){
        EventEmitter.emit.apply (core, queue[i]);
        i++;
        if (i >= j)
            return;
        process.nextTick (queueStep);
    });
});


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
    console.log ('sendEvents', events, this.isReady);
    // if (!this.isReady) {
    //     (this.eventQueue || (this.eventQueue = [])).push.apply (this.eventQueue, events);
    //     return;
    // }
    for (var i=0,j=events.length; i<j; i++)
        core.emit.apply (core, events[i]);
}
core.sendEvents = sendEvents;


/**     @property/Function ready
    Begin firing events. Events will *not* be emitted until this Function is called.
*/
var eventQueue = {};
// var eventQueue;
// var isReady = false;
// function ready(){
//     if (!isReady && eventQueue) {
//         var queue = eventQueue;
//         window.setTimeout (function(){
//             for (var i=0,j=queue.length; i<j; i++)
//                 queue[i]
//         }, 1);
//         delete eventQueue;
//     }
//     this.isReady = true;
// }
// core.ready = ready;


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
window.otherTabs = new EventEmitter();
window.otherTabs.emit = function(){
    var info = Array.prototype.slice.call (arguments);
    window.localStorage.setItem ('__substation_event', JSON.stringify (info));
};
window.addEventListener ('storage', function (event) {
    if (event.key != '__substation_event') return;
    EventEmitter.prototype.emit.apply (otherTabs.emitter, JSON.parse (event.newValue));
});
