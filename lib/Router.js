
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
    this.actionNames = {};
}


/**     @member/Function init
    Prepare the Router to serve requests by running any setup functions on the configured Actions.
@callback
    @argument/Error|undefined err
*/
Router.prototype.init = function (callback) {
    var context = new likeness.helpers.JSContext();
    var self = this;
    // async.each (this.actions, function (action, callback) {
    async.eachSeries (this.actions, function (action, callback) {
        action.setup (self.parent, context, callback);
    }, function (err) {
        if (err) {
            self.parent.logger.fatal ('Action failed during setup', err);
            return process.exit (1);
        }

        // prep global templates
        var globalTemplates;
        if (!self.config.template)
            globalTemplates = {};
        else if (typeof self.config.template == 'function')
            globalTemplates = { '':self.config.template };
        else
            globalTemplates = self.config.template;
        async.each (self.actions, function (action, callback) {
            action.ready (context, globalTemplates, callback);
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
    // return new RegExp ('^/'+str.replace(/[#-.]|[[-^]|[?|{}]/g, '\\$&')+'(?:/(.*))?(?:\\?|$)');
    return new RegExp ('^/'+str+'(?:/(.*))?$');
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
    else if (action.config.method)
        action.method = action.config.method;
    if (route)
        if (typeof route == 'string')
            action.route = stringToRoute (route);
        else
            action.route = route;
    else if (action.config.route)
        if (typeof action.config.route == 'string')
            action.route = stringToRoute (action.config.route);
        else
            action.route = action.config.route;

    // // adjust the route for the way the router views URLs
    // if (action.route) {
    //     var originalRoute = action.route.toString();
    //     var routeStr = originalRoute;

    //     // tart up the route
    //     if (routeStr[routeStr.length-1] == '$')
    //         routeStr = routeStr.slice (0, -1) + '(?:\\?|$)';
    //     if (routeStr[0] == '^') {
    //         if (routeStr.slice (0, 3) != '^\/')
    //             routeStr = '^\/' + routeStr.slice (1);
    //     } else
    //         routeStr = '^\/' + routeStr;

    //     // if the route changed, recreate the RegExp
    //     if (routeStr != originalRoute)
    //         action.route = eval (routeStr);
    // }

    if (!action.name)
        if (action.route)
            action.name = (action.method||'')+':'+action.route.toString().slice(1,-1);
        else
            action.name = (action.method||'')+':/'

    this.actions.push (action);
    // index first action of each name
    if (!Object.hasOwnProperty.call (this.actionNames, action.name))
        this.actionNames[action.name] = action;
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
Router.prototype.getAction = function (request, pathstr, callback) {
    console.log ('Router', pathstr);
    for (var i=0,j=this.actions.length; i<j; i++) {
        var action = this.actions[i];
        if (action.method && action.method != request.method)
            continue;
        if (!action.route)
            return callback (action, [ request.url ]);
        var match = action.route.exec (pathstr);
        if (!match)
            continue;
        var params = match.slice (1);
        for (var i=0,j=params.length; i<j; i++)
            params[i] = decodeURIComponent (params[i]);
        return callback (action, params);
    }
    callback();
};


/**     @member/Function getAllActions

*/
Router.prototype.getAllActions = function (callback) {
    var actions = this.actions;
    process.nextTick (function(){ callback (undefined, actions); });
};


/**     @member/Function getActionByName

*/
Router.prototype.getActionByName = function (name, callback) {
    if (Object.hasOwnProperty.call (this.actionNames, name))
        return callback (undefined, this.actionNames[name]);
    callback();
};


/**     @member/Function configureActions

*/
Router.prototype.configureActions = function (config, callback) {
    for (var i=0,j=this.actions.length; i<j; i++)
        this.actions[i].configure (config);
    callback();
};


/**     @member/Function getOptions
    Obtain a method list and documentation body for a request url, suitable for service of OPTIONS
    requests.
@argument/String path
*/
Router.prototype.getOptions = function (request, callback) {
    var methods = {};
    for (var i=0,j=this.actions.length; i<j; i++) {
        var action = this.actions[i];
        var method = action.method || 'GET';
        if (action.route && !action.route.exec (request.url))
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
    callback (methods);
}


module.exports = Router;
