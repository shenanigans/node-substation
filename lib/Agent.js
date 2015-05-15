
var uid = require ('infosex').uid.craft;

/**     @module/class substation.Agent
    @root
    Central controller for viewing or changing authentication status during an Action. An Agent that
    is logged into the application will *always* have both a `user` and `client` id configured. The
    minimum qualifications for an Agent may already be [configured]
    (substation.Action.configuration.Authentication) for the Action.
    @property/Boolean auth.isLoggedIn
        Whether the user is currently logged in. An Action may occur with a `user` and `client`
        without being an active session - this user presented a previously active session which
        has not received any security flags.
    @property/Boolean auth.isDomestic
        Whether the user copied their "domestication cookie" into the request to confirm the
        request has same-origin priveleges for this domain. This confirmation is absolutely
        critical for any secure write Action.
    @property/String|undefined auth.user
        ID String of the current user, if any.
    @property/String|undefined auth.client
        ID String of the current client, if any.
    @property/Number|undefined sessionCreated
        Epoch time that the user's current session (if any) was initialized. This refers to a
        [login](substation.login) event, not an automatic session key change.
*/
function Agent (parent, cookies, user, client, info, isLoggedIn, isDomestic) {
    this.parent = parent;
    this.cookies = cookies;

    if (arguments.length == 3) {
        this.user = user.user;
        this.client = user.client;
        this.info = user.info;
        this.isLoggedIn = user.isLoggedIn;
        this.isDomestic = user.isDomestic;
        return;
    }

    this.user = user;
    this.client = client;
    this.info = info;
    this.isLoggedIn = isLoggedIn;
    this.isDomestic = isDomestic;
}


/**     @member/Function setActive

*/
Agent.prototype.setActive = function (/* user, client, info, rememberMe, callback */) {
    var user, client, info, rememberMe, callback;
    switch (arguments.length) {
        case 1:
            callback    = arguments[0];
            break;
        case 2:
            rememberMe  = arguments[0];
            callback    = arguments[1];
            break;
        case 3:
            if (typeof arguments[0] == 'object') {
                info = arguments[0];
                rememberMe = arguments[1];
                callback = arguments[2];
            } else {
                rememberMe  = false;
                user        = arguments[0];
                client      = arguments[1];
                callback    = arguments[2];
            }
            break;
        case 4:
            user        = arguments[0];
            client      = arguments[1];
            if (typeof arguments[2] == 'boolean')
                rememberMe  = arguments[2];
            else {
                info        = arguments[2];
                rememberMe  = false;
            }
            callback    = arguments[3];
            break;
        default:
            user        = arguments[0];
            client      = arguments[1];
            info        = arguments[2];
            rememberMe  = arguments[3];
            callback    = arguments[4];
    }

    if (user)
        this.user = user;
    if (client)
        this.client = client;

    if (!this.client || !this.user)
        return process.nextTick (function(){
            callback (new Error ('user and client ID required'))
        });

    this.parent.setActive (this.user, this.client, info, rememberMe, this.cookies, callback);
};


/**     @member/Function setIdle

*/
Agent.prototype.setIdle = function (/* user, client, info, rememberMe, callback */) {
    var user, client, info, rememberMe, callback;
    switch (arguments.length) {
        case 1:
            callback    = arguments[0];
            break;
        case 2:
            rememberMe  = arguments[0];
            callback    = arguments[1];
            break;
        case 3:
            if (typeof arguments[0] == 'object') {
                info = arguments[0];
                rememberMe = arguments[1];
                callback = arguments[2];
            } else {
                rememberMe  = false;
                user        = arguments[0];
                client      = arguments[1];
                callback    = arguments[2];
            }
            break;
        case 4:
            user        = arguments[0];
            client      = arguments[1];
            if (typeof arguments[2] == 'boolean')
                rememberMe  = arguments[2];
            else {
                info        = arguments[2];
                rememberMe  = false;
            }
            callback    = arguments[3];
            break;
        default:
            user        = arguments[0];
            client      = arguments[1];
            info        = arguments[2];
            rememberMe  = arguments[3];
            callback    = arguments[4];
    }

    if (user)
        this.user = user;
    if (client)
        this.client = client;

    if (!this.client || !this.user)
        return process.nextTick (function(){
            callback (new Error ('user and client ID required'))
        });

    this.parent.setIdle (this.user, this.client, info, rememberMe, this.cookies, callback);
};


/**     @member/Function logout

*/
Agent.prototype.logout = function (/* client, callback */) {
    var client, callback;
    if (arguments.length == 1)
        callback = arguments[0];
    else {
        client = arguments[0];
        callback = arguments[1];
    }
    if (!this.client || !this.user)
        return process.nextTick (callback);

    this.parent.logout (this.user, client, this.cookies, callback);
};


/**     @member/Function export

*/
Agent.prototype.export = function(){
    return {
        user:           this.user,
        client:         this.client,
        info:           this.info,
        isLoggedIn:     this.isLoggedIn,
        isDomestic:     this.isDomestic
    };
};


module.exports = Agent;
