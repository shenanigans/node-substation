
node-substation
===============
**Warning** This project is still in the early development stage. It is not ready for public
testing.

A realtime application gateway, session manager, event router and WebRTC signaling server for
[Node.js](https://nodejs.org/) and [MongoDB](https://www.mongodb.org/).
 * scalable deployment out of the box
 * manages database-backed sessions and browser cookies
 * provides robust XSS-attack protection
 * obfuscates [Socket.io](http://socket.io/) over your REST api
 * validates requests with JSON Schema
 * exposes your api and schema with automatic OPTIONS support
 * passively routes best-effort events to users connected over Socket.io
 * automates WebRTC connections between authenticated users

The state of the art in realtime, and particularly in peer to peer, is that even with the best shims
easy jobs never are. "Room"-based libraries make lovely tutorials and demos but the leap from these
barely-functional user experiences to a usable, scalable social application is too complex for
anyone but the top competitive voip companies to manage.

The goal of `substation` is to bridge that gap by reversing signal flow. A user logged in to your
application no longer has to ask to be reachable, they are reachable by identity as soon as their
Socket.io connection becomes active. Connection multiplicity is embraced by shipping events to
groups of related useragents (usually multiple tabs). Robust WebRTC peer "Links" are provided that
automatically connect and reconnect new connections to the Link as long as both peers maintain at
least one connection to the server.

Whether your application is a game server, a social application, a collaborative editing tool, a
telecom service or something totally novel to Planet Earth, `substation` aims to support your
signaling requirements, at scale, out of the box.


Deployment
----------
A MongoDB cluster is required for storing session and live connection metadata. You are under no
obligation to use MongoDB for any of your application data or otherwise use it for any other
purpose.

`substation` runs on [Node.js](https://nodejs.org/) and installs with [npm](https://www.npmjs.com/).
It is configured and launched from a parent script and does not have a CLI tool. A simple, robust,
cross-platform way to keep your server running is to launch it with [forever]
(https://github.com/foreverjs/forever).
```bash
npm install --save substation
npm install -g forever
forever myApp.js
```

Like most webapp servers, `substation` must live behind a gateway server for load-balancing. The
load balancer must be "sticky" - a frequent stream of requests from the same agent must be routed to
the same service node. This is a requirement of Socket.io. `substation` also currently expects the
load-balancer to terminate `ssl` connections, as this is generally considered a "best practise" and
`ssl` termination should probably be done by the most trusted software on your stack. With all love
for Node, if Node is the most trusted software on your entire stack you are being very
irresponsible.

The recommended load balancer for `substation` is [nginx](http://nginx.org/). Your configuration
should contain something like this:
```
upstream myapp {
    ip_hash;
    server alfa.myapp.com;
    server sierra.myapp.com;
    server hotel.myapp.com;
}

server {
    Listen              443 ssl;
    server_name         myapp.com;
    ssl_certificate     myapp.com.crt;
    ssl_certificate_key myapp.com.key;

    location / {
        proxy_set_header    X-Real-IP $remote_addr;
        proxy_set_header    X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header    Host $http_host;
        proxy_set_header    X-NginX-Proxy true;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_redirect      off;
        proxy_pass          http://myapp/;
    }

    location /static {
        root                www/myapp;
    }
}
```


Getting Started
---------------
The entry point for a simple application might look something like this:
```javascript
var substation = require ('substation');
var config = require ('./config');

// create a new server
var myServer = new substation (config);
var otherServer = substation (config);

// set a route
myServer.addAction (
    "GET",
    new RegExp ("/msg/(\\d+)"),
    require ('./src/message/GET')
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
substation.addAction (
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

To get a handle on what `substation.addAction (...` does and what `./src/message/POST.js` might look
like, read through the next sections.


### Actions
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
home.addAction (
    'PUT',
    '/posts/12345',
    { title:postTitle, content:postBody },
    function (err, status, body) {
        console.log ('action complete');
    }
);

// logs "using http"
// order of last two logging statements
// is not defined
```

On the server side, an Action is defined by a handful of configuration options and a reaction
function.
```javascript
// templates are expected to be callables
// EITHER template (contextObj)
// OR template (contextObj, callback (err, html))
var template_201 = handlebars.compile (
    fs.readFileSync (201_filename).toString()
);
var template_406 = handlebars.compile (
    fs.readFileSync (406_filename).toString()
);
var template_409 = handlebars.compile (
    fs.readFileSync (409_filename).toString()
);

var PostSchema = {
    properties: {
        title:      {
            type:       "string",
            match:      "\\w",
            maxLength:  128
        },
        content:    {
            type:       "string",
            match:      "\\w",
            maxLength:  20480
        }
    }
});

// create an Action instance
var substation = require ('substation');
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
    reply.event (
        'newPost',
        agent.user,
        request.params[0]
    );

    // content is reported as `body` to the
    // client's request callback
    reply.content ({
        accepted:   true,
        totalPosts: postCount
    });

    // close the Action
    // and select a template
    reply.done (201);
});

// export the action on the monolith server
substation.addAction (
    'PUT',
    /\/post\/(\d+)/,
    NewPost
);
```


### Authentication
`substation` features an uncommon dual-layer authentication scheme, intended to accomodate
origin-specific policies by default. Each unique user ID owns any number of unique client IDs,
representing the individual devices used to access your application. You *must* have a User *and* a
Client to log in. You *may* assign the same Client to every login if you don't need this feature.

A common example of this scheme implemented in the wild is [Steam](http://store.steampowered.com/).
When connecting to a Steam account from a "new computer" the email-validation stage must be repeated
using a short alphanumeric code. `substation` has no opinion about how Clients should be validated,
whether new Clients need to be confirmed, etc. You are only required to generate a Client ID to log
in as, and ask `substation` to declare the user "active".
```javascript
var LoginAction = new substation.Action (login);
function login (station, agent, request, reply) {
    if (agent.isLoggedIn) {
        // this User is already logged in
        return reply.done();
    }

    // authenticate the User
    var userID, clientID;
    if (agent.client) {
        // this User has a cookie but not a session
        // ...
    } else {
        // this User is connecting with a new Device
        // ...
    }

    function finalize (err) {
        if (err)
            return reply.done (403);
        reply.done();
    }

    // the Boolean argument to setActive is "Remember Me"
    // it controls browser cookie retention
    agent.setActive (userID, clientID, true, finalize);
}
```

The primary purpose of this system is localization: if a user does something on your site from their
phone, it might be helpful to target later events directly to their phone, even if their desktop at
home was left open to the same page.

In addition to being a logged in (or not) a user may also be domestic (or not) indicating that their
viewing context has same-origin permissions for the domain. On the client this is fully transparent:
every action that can be domestic will be. On the server, a property is set on the Agent.
```javascript
function PostAction (station, agent, request, reply) {
    if (agent.isDomestic) {
        // user has same-origin access to the domain
    } else {
        // viewed in an insecure context
        // such as an iframe
    }
}
```


### Events
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
goes on or off line. These events only occur one time, on one server in the cluster, for each time
the user or client changes state.
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

A small note: if you were smashing "refresh" on your test application and now your Users and Clients
appear to be stuck online, wait ten seconds for Socket.io connections which failed in the
polling/upgrade phase to timeout.


### WebRTC
WebRTC connections are made semi-automatically. The request is initialized by the client machine and
produces an event on the server. Listeners on this event may allow the connection to proceed, after
which remaining SDP and ICE exchange phases are automatic. The "Link" created between two Users or
Clients will remain active for as long as at least one connection *to the server* remains active
from each peer. As long as the Link is active, newly active connections (e.g. the user opens a new
tab) will automatically join the Link by creating WebRTC connections and DataChannels to every other
remote peer.

Multimedia stream handling has been massively streamlined, with renegotiation of the underlying
connection handled automatically. Streams can be added to or removed from a peer connection at any
time without disruption. Multimedia streams will be duplicated to every connected Peer on the Link,
so multimedia applications should consider selecting Peers by Client and disabling streams when not
in use. Remember that if no Elements on the page refer to the stream no packets will be sent,
however calling `pause()` is not sufficient.

Due to the insanity that is WebRTC, Some stream renegotiation phases would normally disrupt your
existing streams, replacing them with duplicates. In these cases, `substation` will attempt to swap
the replacement stream into any `<video>` elements on the page and the stream should not emit the
`close` event. Unfortunately, the "unique id" set to incoming streams in most browsers today is
always "default" which complicates multiplexing somewhat. If you wish to use multiple streams per
client, they must be **either** differentiable by introspection, i.e. one audio one video, different
bitrates, etc. **or** only add or remove all streams simultaneously.

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

        // find the "friend" User and authenticate
        // ...

        connect (
            friend.userID,
            // connect client to client
            friend.clientID,
            // tell "friend" who "agent" is
            { email:agent.info.email },
            function (err, sent) {
                // if a message went out
                // `sent` will be `true`
            }
        );
    }
);
```


LICENSE
-------
The MIT License (MIT)

Copyright (c) 2015 Kevin "Schmidty" Smith

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
