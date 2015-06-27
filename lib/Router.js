
var async = require ('async');
var likeness = require ('likeness');
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
    var context = new likeness.helpers.JSContext();
    var self = this;
    async.each (this.actions, function (action, callback) {
        action.setup (self.parent, context, callback);
    }, function (err) {
        if (err) {
            this.parent.logger.fatal ('Action failed during setup', err);
            return process.exit (1);
        }
        async.each (self.actions, function (action, callback) {
            action.ready (context, callback);
        }, function (err) {
            if (err) {
                self.parent.logger.fatal ('Action failed during setup', err);
                return process.exit (1);
            }
            callback();
        });
    });
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


/**     @member/Function getOptions
    Obtain a method list and documentation body for a request url, suitable for service of OPTIONS
    requests.
@argument/String path
*/
Router.prototype.getOptions = function (path) {
    var methods = {};
    for (var i=0,j=this.actions.length; i<j; i++) {
        var action = this.actions[i];
        var method = action.method || 'GET';
        if (action.route && !action.route.exec (path))
            continue;
        if (Object.hasOwnProperty.call (methods, method))
            continue; // first action wins
        if (!action.querySchemaExport && !action.bodySchemaExport) {
            methods[method] = true;
            continue;
        }
        var doc = methods[method] = {};
        if (action.querySchemaExport)
            doc.query = action.querySchemaExport;
        if (action.bodySchemaExport)
            doc.body = action.bodySchemaExport;
        continue;
    }
    return methods;
}


module.exports = Router;
