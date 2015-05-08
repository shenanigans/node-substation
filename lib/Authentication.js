
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

            callback();
        });
    });
};


/**     @member/Function logout
    @development
    End the current session and ask the user to delete their session cookies. The logout request is
    propogated over the backplane in order to flush it from every session cache.
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
    SessionsCollection.findAndModify (
        { _id:currentSession },
        [ [ '_id', 1 ] ],
        { $set:{ v:false } },
        function (err, rec) {
            if (err) return callback (err);
            if (!rec) return callback();

            rec.v = false;
            if (sessionCache)
                sessionCache.set (rec._id, rec);

            cookies.set ('session');
            cookies.set ('domestic');

            callback();
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
    var isLoggedOut = cookies.get ('loggedOut');
    var confirm = path.query._domestic;
    var isDomestic = false;
    var config = this.config;

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
                    this,
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
    var self = this;
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
