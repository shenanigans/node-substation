
node-substation
===============
A realtime application gateway and authentication provider for [Node.js](https://nodejs.org/) and
[MongoDB](https://www.mongodb.org/).
 * manages sessions and cookies transparently
 * exposes robust XSS protection by default
 * obfuscates [Socket.io](http://socket.io/) over your REST api
 * routes events to live-connected users anywhere on the cluster
 * automates WebRTC connections between authenticated users


Getting Started
---------------
```bash
npm install substation
```
```javascript
var substation = require ('substation');
var config = require ('./config');

// create a new server
var myServer = new substation (config);
var otherServer = substation (config);

// set a route
myServer.action (
    "GET",
    new RegExp ("/msg/(\\d+)"),
    require ('./src/message/get')
);

// activate a server
myServer.listen (function (err) {
    if (err) {
        console.error (err);
        return process.exit (1);
    }
    console.log ('server online!');
});

// use the monolith
substation.action (
    "POST",
    new RegExp ("/msg/(\\d+)"),
    require ('./src/message/POST')
);
substation.configure (config);
substation.listen (function (err) {
    if (err) {
        console.error (err);
        return process.exit (1);
    }
    console.log ('monolith online!');
});
```


Actions
-------
Actions are similar to the routes in other frameworks, except they are accessible over [Socket.io]
(http://socket.io/) and automatically select whether to apply a template or just send JSON. If you
use the [Browserify-enabled](http://browserify.org/) client library to perform an Action you need
never know what transport was used.

```javascript
var home = substation.getServer();
console.log ('using http');
home.goLive (function (err) {
    console.log ('switched to socket.io');
});
home.action (
    'PUT',
    '/posts/12345',
    { title:postTitle, content:postBody },
    function (err, status, body) {
        console.log ('action complete');
    }
);
```

On the server side, an Action is defined by a handful of configuration options and a reaction
function.
```javascript
// templates are expected to be callables
// EITHER template (contextObj)
// OR template (contextObj, callback (err, html))
var template_201 = handlebars
    .compile (
        fs.readFileSync (201_filename)
         .toString()
    );
var template_406 = handlebars
    .compile (
        fs.readFileSync (406_filename)
         .toString()
    );
var template_409 = handlebars
    .compile (
        fs.readFileSync (409_filename)
         .toString()
    );

// validators are expected to be callables
// EITHER validate (document)
// OR validate (document, callback (err))
var PostSchema = new likeness.Validator ({
    title:      {
        '.type':    'string',
        // require >= one word char
        '.match':   /\w/,
        '.max':     128
    },
    content:    {
        '.type':    'string',
        // require >= one word char
        '.match':   /\w/,
        '.max':     20480
    }
});

var NewPost = new substation.Action ({
    authentication: {
        isLoggedIn:     true
    },
    template:       {
        201:            template_201,
        406:            template_406,
        409:            template_409
    },
    bodySchema:     PostSchema
}, function (station, agent, request, reply) {

    // save the post
    // ...

    // events are emitted from the client's
    // `substation` Object
    reply.event ('newPost', {
        user:   agent.user,
        postID: request.params[0]
    });

    // content is reported as `body` to the
    // client's request callback
    reply.content ({ total:postCount });

    // when html is expected,
    // this call selects the template
    reply.done (201);
});

substation.action (
    'PUT',
    /\/post\/(\d+)/,
    NewPost
);
```


Authentication
--------------
`substation` features an uncommon dual-layer authentication scheme, intended to accomodate
origin-specific policies by default. Each unique user ID owns any number of unique client IDs,
representing the individual devices used to access your application. You *must* have a User *and* a
Client to log in.

A common example of this scheme implemented in the wild is [Steam](http://store.steampowered.com/).
When connecting to a Steam account from a "new computer" the email-validation stage must be repeated
using a short alphanumeric code. `substation` has no opinion about how Clients should be validated,
whether new Clients need to be confirmed, etc. You are only required to generate a Client ID to log
in as, and ask `substation` to declare the user "active".

```javascript
var LoginAction = new substation.Action (login);
function login (station, agent, request, reply) {

    // authenticate the user somehow
    // ...

    agent.setActive (userID, clientID, true, callback);
}
```


Events
------
Emitting an event on a client device is very easy, even if they haven't used an Action recently. You
may target events to all active connections of a user ID or user/client ID pair.

```javascript
var LoginAction = new substation.Action (login);
function login (station, agent, request, reply) {

    // identify users who care that we are logged in
    // ...

    friends.forEach (function (friendID) {
        station.sendEvent (
            friendID,
            { id:agent.user, loggedIn:true }
        );
    });
}
```

Events are emitted by `substation` whenever the first or last connection for a User or Client ID
goes on or off line.
```javascript
substation.on ('userOnline', function (userID) {

    // identify users who care that we are online
    // ...

    friends.forEach (function (friendID) {
        station.sendEvent (
            friendID,
            { id:agent.user, online:true }
        );
    });
});

substation.on ('userOffline', function (userID) {
    // ...
});
substation.on ('clientOnline', function (userID) {
    // ...
});
substation.on ('clientOffline', function (userID) {
    // ...
});
```


WebRTC
------
WebRTC connections are made semi-automatically. The request is initialized by the client machine and
produces an event on the server. Listeners on this event may allow the connection to proceed, after
which remaining SDP and ICE exchange phases are automatic.

On the client:
```javascript
// get our home server
var server = substation.getServer();
// get and connect a peer
var peer = server.getPeer (
    { email:'name@url.tld' }
);
peer.connect (function (err) {
    if (err) {
        console.log ('peer connection failed', err);
        return;
    }
    console.log ('peer connection succeeded');
    // emit an event on the remote client
    peer.emit ('connected', { id:'12345' });
});
```

On the server:
```javascript
substation.on (
    'peerRequest',
    function (agent, info, connect) {

        // find the user and authenticate
        // ...

        connect (
            friend.userID,
            friend.clientID,
            { email:agent.info.email },
            function (err, sent) {
                // if a message was sent out
                // `sent` will be `true`
            }
        );
    }
);
```
