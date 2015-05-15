
var url = require ('url');
var nssocket = require ('nssocket');
var cachew = require ('cachew');
var sexxion = require ('infosex').session;
var Common = require ('./Common');
var Agent = require ('./Agent');


/**     @module/class substation.Authentication
    @root
    Looks up, creates and manages sessions on the database as well as managing browser cookies.
@argument/substation parent
@argument/.Configuration config
*/
function Authentication (parent, config) {
    this.parent = parent;
    this.config = config;
}


/**     @struct Configuration
    Options for authenticating users and keeping them authentic (or not).
@member/mongodb.Collection|undefined SessionsCollection
    Optionally override MongoDB setup however you want by passing in a pre-configured Collection
    driver instance.
@member/Number|Boolean cacheSessions
    Maximum number of sessions to cache in memory, or Boolean false to disable. Setting to `0` also
    disables the cache.
@member/String sessionsCollectionName
    @default `"Sessions"`
    Name of the MongoDB collection used to store session records. Ignored when using
    `SessionsCollection`.
@member/Number sessionCacheTimeout
    @default `thirty minutes`
    Maximum time (milliseconds) to cache a session without confirming its database record. Setting
    to `0` disables cache timeouts entirely. Calling [setIdle](substation.Authentication#setIdle) or
    [logout](substation.Authentication.logout) will distribute the session update to affected server
    instances, so the cache timeout is just a safety net.
@member/Number sessionLifespan
    @default `one day`
    Maximum time (milliseconds) that a session token remains valid after it is created. This timeout
    produces a fresh token without interrupting the active login.
@member/Number sessionRenewalTimeout
    @default `three days`
    Maximum time (milliseonds) since the user's last period of activity until a new session token
    can no longer be generated. The Client will be `idle` until [setActive](.Agent#setActive) is
    called.
@member/Number loginLifespan
    @default `two weeks`
    Maximum time (milliseconds) since the user's last [login event](.Agent#setActive) until their
    active session ends and cannot be renewed. Set to `0` (or another untruthy value) to disable,
    allowing a sufficiently active session to remain logged in until time stops.
@member/Number cookieLifespan
    @default `one year`
    When the "remember me" flag is set, cookies are saved for this duration, in milliseconds. The
    Client will be [idle](.Agent#setIdle) for as long as it retains this cookie.
*/


/**     @member/Function init
    When clustering, prepares the cluster port for authentication requests from other processes.
    Otherwise, `Authentication` doesn't require setup and simply nextTick's the callback.
@callback
*/
Authentication.prototype.init = function (callback) {
    if (this.config.cacheSessions)
        this.sessionCache = new cachew.ChainCache (
            this.config.cacheSessions,
            this.config.sessionCacheTimeout
        );

    return process.nextTick (callback);
};


/**     @member/Function setActive
    @development
    Create a new valid session and give the user some cookies to authenticate it.
@argument/String user
@argument/String client
@argument/Object info
@argument/Boolean rememberMe
@argument/cookies cookies
@callback
*/
Authentication.prototype.setActive = function (user, client, info, rememberMe, cookies, callback) {
    var config = this.config;
    var sessionCache = this.sessionCache;
    var SessionsCollection = this.parent.SessionsCollection;
    sexxion.craft (function (newSession, domesticate) {
        var now = (new Date()).getTime();
        var newRecord = {
            _id:    newSession,
            c:      now,        // created
            a:      now,        // activeTime
            v:      true,       // isValid
            U:      user,       // userID
            C:      client,     // clientID
            l:      null,       // lastSession
            f:      newSession, // firstSession
            L:      now,        // loginTime
            r:      rememberMe, // "remember me"
            I:      info || {}
        };
        SessionsCollection.insert (newRecord, { w:1 }, function (err) {
            if (err) return callback (err);

            if (rememberMe) {
                cookies.set (
                    'session',
                    newSession,
                    { httpOnly:true, maxAge:config.cookieLifespan }
                );
                cookies.set (
                    'domestic',
                    domesticate,
                    { httpOnly:false, maxAge:config.cookieLifespan }
                );
            } else {
                cookies.set ('session', newSession, { httpOnly:true });
                cookies.set ('domestic', domesticate, { httpOnly:false });
            }
            // delete the loggedOut cookie, if present
            cookies.set ('loggedOut');

            if (sessionCache)
                sessionCache.set (newSession, newRecord);

            callback (undefined, newRecord);
        });
    });
};


/**     @member/Function setIdle
    @development
    End the current session, converting the user to `idle` status. If there is no current session,
    a pre-expired session is created and the user is given its authentication cookies.
@argument/String user
@argument/String client
@argument/cookies cookies
@callback
*/
Authentication.prototype.setIdle = function (user, client, info, rememberMe, cookies, callback) {
    var config = this.config;
    var sessionCache = this.sessionCache;
    var backplane = this.parent.backplane;
    var SessionsCollection = this.parent.SessionsCollection;

    // create a new, pre-expired session
    var config = this.config;
    var sessionCache = this.sessionCache;
    sexxion.craft (function (newSession, domesticate) {
        var now = (new Date()).getTime();
        var newRecord = {
            _id:    newSession,
            c:      now,        // created
            a:      now,        // activeTime
            v:      false,      // isValid
            U:      user,       // userID
            C:      client,     // clientID
            l:      null,       // lastSession
            f:      null,       // firstSession
            L:      null,       // loginTime
            r:      rememberMe,
            I:      info || {}
        };
        SessionsCollection.insert (newRecord, function (err) {
            if (err) return callback (err);

            if (rememberMe) {
                cookies.set (
                    'session',
                    newSession,
                    { httpOnly:true, maxAge:config.cookieLifespan }
                );
                cookies.set (
                    'domestic',
                    domesticate,
                    { httpOnly:false, maxAge:config.cookieLifespan }
                );
            } else {
                cookies.set ('session', newSession, { httpOnly:true });
                cookies.set ('domestic', domesticate, { httpOnly:false });
            }

            if (sessionCache)
                sessionCache.set (newSession, newRecord);

            backplane.kick (user, client, function (err) {
                if (err) {
                    logger.error ('failed to kick user from Backplane', err);
                    return callback (new Error ('internal error'));
                }
                callback();
            });
        });
    });
};


/**     @member/Function logout
    @development
    End the current session. If the "remember me" flag was not set, the client is asked to delete
    their cookies.
@argument/String user
@argument/String client
@argument/cookies cookies
@callback
*/
Authentication.prototype.logout = function (user, client, cookies, callback) {
    var config = this.config;
    var sessionCache = this.sessionCache;
    var backplane = this.parent.backplane;
    var currentSession = cookies.get ('session');
    var SessionsCollection = this.parent.SessionsCollection;
    if (!currentSession)
        return callback();

    var query = { U:user };
    if (client)
        query.C = client;
    SessionsCollection.update (
        query,
        { $set:{ v:false } },
        { multi:true },
        function (err) {
            if (err) return callback (err);
            backplane.kick (user, client, function (err) {
                if (err) {
                    logger.error ('failed to kick user from Backplane', err);
                    return callback (new Error ('internal error'));
                }
                callback();
            });
        }
    );
};


/**     @member/Function getSession

@argument/Object path
    `request.url` preparsed by the [url module](url.parse). Just an efficiency hack to avoid
    reparsing.
@argument/http.IncomingMessage request
@argument/http.ServerResponse response
@callback
    @argument/Error|undefined err
    @argument/substation.AuthenticationStatus auth
*/
Authentication.prototype.getSession = function (path, cookies, callback) {
    var session = cookies.get ('session');
    var confirm = path.query._domestic;
    var isDomestic = false;
    var config = this.config;
    var self = this;

    if (!session)
        return callback (undefined, new Agent (this, cookies));

    // cached session?
    var sessionRecord;
    if (this.sessionCache)
        sessionRecord = this.sessionCache.get (session);
    if (sessionRecord) {
        if (path.query._domestic) {
            var sessionInfo = sexxion.parse (session);
            if (sessionInfo.domesticate != path.query._domestic)
                return callback (undefined, new Agent (this, cookies));
            isDomestic = true;
        }

        var now = (new Date()).getTime();
        // login event forced invalid or past hard timeout?
        if (!sessionRecord.v || now - sessionRecord.L >= config.loginLifespan)
            return callback (undefined, new Agent (
                this,
                cookies,
                sessionRecord.U,
                sessionRecord.C,
                sessionRecord.I,
                false,
                isDomestic
            ));

        // still in date?
        if (now - sessionRecord.c < config.sessionLifespan)
            return callback (undefined, new Agent (
                this,
                cookies,
                sessionRecord.U,
                sessionRecord.C,
                sessionRecord.I,
                true,
                isDomestic
            ));

        // fresh enough to renew?
        if (now - sessionRecord.a < config.sessionRenewalTimeout)
            return this.renewSession (sessionRecord, cookies, function (err, newSession) {
                if (err) return callback (err);

                callback (undefined, new Agent (
                    self,
                    cookies,
                    sessionRecord.U,
                    sessionRecord.C,
                    sessionRecord.I,
                    true,
                    isDomestic
                ));
            });

        // expired session
        return callback (undefined, new Agent (
            this,
            cookies,
            sessionRecord.U,
            sessionRecord.C,
            sessionRecord.I,
            false,
            isDomestic
        ));
    }

    // fetch session record from database, if able
    this.parent.SessionsCollection.findOne ({ _id:session }, function (err, record) {
        if (err)
            return callback (err);

        if (!record) // invalid session
            return callback (undefined, new Agent (self, cookies));

        sessionRecord = record;
        var now = (new Date()).getTime();

        if (path.query._domestic) {
            var sessionInfo = sexxion.parse (session);
            if (sessionInfo.domesticate != path.query._domestic)
                return callback (undefined, new Agent (self, cookies));
            isDomestic = true;
        }

        // login event forced invalid or past hard timeout?
        if (!sessionRecord.v || now - sessionRecord.L >= config.loginLifespan)
            return callback (undefined, new Agent (
                self,
                cookies,
                sessionRecord.U,
                sessionRecord.C,
                sessionRecord.I,
                false,
                isDomestic
            ));

        // still in date?
        if (now - sessionRecord.c < config.sessionLifespan)
            return callback (undefined, new Agent (
                self,
                cookies,
                sessionRecord.U,
                sessionRecord.C,
                sessionRecord.I,
                true,
                isDomestic
            ));

        // fresh enough to renew?
        if (now - sessionRecord.a < config.sessionRenewalTimeout)
            return self.renewSession (sessionRecord, cookies, function (err, newSession) {
                if (err) return callback (err);

                callback (undefined, new Agent (
                    self,
                    cookies,
                    sessionRecord.U,
                    sessionRecord.C,
                    sessionRecord.I,
                    true,
                    isDomestic
                ));
            });

        // expired session
        return callback (undefined, new Agent (
            self,
            cookies,
            sessionRecord.U,
            sessionRecord.C,
            sessionRecord.I,
            false,
            isDomestic
        ));
    });
};


/**     @member/Function renewSession
    @development

*/
Authentication.prototype.renewSession = function (session, cookies, callback) {
    var config = this.config;
    var sessionCache = this.sessionCache;
    var SessionsCollection = this.parent.SessionsCollection;
    sexxion.craft (function (newSession, domesticate) {
        var newRecord = {
            _id:    newSession,
            c:      (new Date()).getTime(),
            a:      session.a,      //
            U:      session.U,      // User ID
            C:      session.C,      // Client ID
            l:      session._id,    // previous session in chain
            f:      session.f,      // first session in chain
            L:      session.L,      // timestamp of session chain initial login
            r:      session         //
        };
        SessionsCollection.insert (newRecord, function (err) {
            if (err) return callback (err);

            if (session.r) {
                cookies.set (
                    'session',
                    newSession,
                    { httpOnly:true, maxAge:config.cookieLifespan }
                );
                cookies.set (
                    'domestic',
                    domesticate,
                    { httpOnly:false, maxAge:config.cookieLifespan }
                );
            } else {
                cookies.set ('session', newSession, { httpOnly:true });
                cookies.set ('domestic', domesticate, { httpOnly:false });
            }

            if (sessionCache)
                sessionCache.set (newSession, newRecord);

            callback (undefined, newRecord);
        });
    });
};


module.exports = Authentication;
