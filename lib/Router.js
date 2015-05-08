
var async = require ('async');
var Common = require ('./Common');

/**     @struct substation.Configuration

*/
var DEFAULT_CONFIG = {

};


/**     @module/class substation.Router
    @root

@argument/substation parent
@argument/substation.Configuration
*/
function Router (parent, config) {
    this.parent = parent;
    this.config = Common.clone (DEFAULT_CONFIG);
    Common.merge (this.config, config);

    this.actions = [];
}


/**     @member/Function init
    Prepare the Router to serve requests by running any setup functions on the configured Actions.
@callback
    @argument/Error|undefined err
*/
Router.prototype.init = function (callback) {
    async.each (this.actions, function (action, callback) {
        action.ready (callback);
    }, callback);
};


/**     @local/Function stringToRoute
    Convert a String path into a RegExp matching any String prefixed with the source String and
    grouping all trailing characters.
*/
function stringToRoute (str) {
    return new RegExp ('^/'+str.replace(/[#-.]|[[-^]|[?|{}]/g, '\\$&')+'(?:/(.*))?');
}


/**     @member/Function addAction

*/
Router.prototype.addAction = function (/* method, route, action */) {
    var method, route, action;
    switch (arguments.length) {
        case 1:
            action = arguments[0];
            break;
        case 2:
            route = arguments[0];
            action = arguments[1];
            break;
        default:
            method = arguments[0];
            route = arguments[1];
            action = arguments[2];
    }

    if (method)
        action.method = method.toUpperCase();
    if (route)
        if (typeof route == 'string')
            action.route = stringToRoute (route);
        else
            action.route = route;
    if (!action.name)
        if (route)
            action.name = (action.method||'')+':'+action.route.toString().slice(1,-1);
        else
            action.name = (action.method||'')+':/'

    this.actions.push (action);
};


/**     @member/Function getAction
    Synchronously supplies the callback with the first matched route and selecting groups, if any.
@argument/Object path
    A url represntation object as produced by the standard `url` package.
@callback
    @argument/substation.Action|undefined action
    @argument/Array[String] params
        @optional
*/
Router.prototype.getAction = function (path, method, callback) {
    for (var i=0,j=this.actions.length; i<j; i++) {
        var action = this.actions[i];
        if (action.method && action.method != method)
            continue;
        if (!action.route)
            return callback (action, [ path ]);
        var match = action.route.exec (path);
        if (!match)
            continue;
        return callback (action, match.slice (1));
    }
    callback();
};


module.exports = Router;
