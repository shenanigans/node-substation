
var http = require ('http');
var https = require ('https');
var filth = require ('filth');

/**     @module/class substation:RemoteAgent

@argument/substation.Configuration config
@argument/String|undefined user
@argument/String|undefined client
@argument/Boolean isLoggedIn
@argument/Boolean isDomestic
*/
function RemoteAgent (config, domain, user, client, isLoggedIn, isDomestic, rememberMe) {
    this.config = config;
    this.domain = domain;
    this.user = user;
    this.client = client;
    this.isLoggedIn = isLoggedIn;
    this.isDomestic = isDomestic;
}

RemoteAgent.prototype.updateRemote = function (newStatus, rememberMe, callback) {
    var options = {
        host:   this.config.APIHost,
        method: 'POST',
        path:   '/session?apiKey='
                  + encodeURIComponent (this.config.APIKey)
                  + '&user='
                  + encodeURIComponent (this.user)
                  + '&client='
                  + encodeURIComponent (this.client)
                  + '&status='
                  + newStatus
                  + '&rememberMe='
                  + Boolean (rememberMe)
    };

    // var apiRequest = https.request (options, function (response) {
    var apiRequest = http.request (options, function (response) {
        var status = response.statusCode;
        response.emit ('end');

        if (status == '200')
            return callback();
        if (status == '403')
            return callback (new Error ('API Key rejected'));
        callback (new Error ('unexpected client error'));
    });
    apiRequest.on ('error', callback);
    apiRequest.end();
};

RemoteAgent.prototype.setActive = function (/* user, client, rememberMe, callback */) {
    var user, client, rememberMe, callback;
    switch (arguments.length) {
        case 1:
            callback    = arguments[0];
            break;
        case 2:
            rememberMe  = arguments[0];
            callback    = arguments[1];
            break;
        case 3:
            user        = arguments[0];
            client      = arguments[1];
            callback    = arguments[2];
            break;
        default:
            user        = arguments[0];
            client      = arguments[1];
            rememberMe  = arguments[2];
            callback    = arguments[3];
    }

    if (user)
        this.user = user;
    if (client)
        this.client = client;
    this.isLoggedIn = true;

    if (!this.client || !this.user)
        return process.nextTick (function(){
            callback (new Error ('user and client ID required'))
        });

    this.changed = {
        setStatus:  'active',
        user:       this.user,
        client:     this.client,
        rememberMe: rememberMe
    };
    process.nextTick (callback);
};

RemoteAgent.prototype.setIdle = function (/* user, client, rememberMe, callback */) {
    var user, client, rememberMe, callback;
    switch (arguments.length) {
        case 1:
            callback    = arguments[0];
            break;
        case 2:
            rememberMe  = arguments[0];
            callback    = arguments[1];
            break;
        case 3:
            user        = arguments[0];
            client      = arguments[1];
            callback    = arguments[2];
            break;
        default:
            user        = arguments[0];
            client      = arguments[1];
            rememberMe  = arguments[2];
            callback    = arguments[3];
    }

    // local setup
    if (user)
        this.user = user;
    if (client)
        this.client = client;
    this.isLoggedIn = false;

    if (!this.client || !this.user)
        return process.nextTick (function(){
            callback (new Error ('user and client ID required'))
        });

    this.changed = {
        setStatus:  'idle',
        user:       this.user,
        client:     this.client,
        rememberMe: rememberMe
    };
    process.nextTick (callback);
};


/**     @member/Function logout

*/
RemoteAgent.prototype.logout = function (/* client, callback */) {
    var client, callback;
    if (arguments.length == 1)
        callback = arguments[0];
    else {
        client = arguments[0];
        callback = arguments[1];
    }
    if (!this.client || !this.user)
        return process.nextTick (callback);

    // local setup
    this.isLoggedIn = false;
    this.isDomestic = false;
    if (!this.rememberMe) {
        delete this.user;
        delete this.client;
    }

    this.changed = {
        setStatus:  'logout'
    };
    if (client)
        this.changed.client = client;
    process.nextTick (callback);
};


/**     @member/Function export

*/
RemoteAgent.prototype.export = function(){
    return {
        user:           this.user,
        client:         this.client,
        isLoggedIn:     this.isLoggedIn,
        isDomestic:     this.isDomestic
    };
};

module.exports = RemoteAgent;
