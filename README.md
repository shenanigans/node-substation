
node-substation
===============
**Warning** This project is currently in alpha testing.

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

This module is used to serve your apps locally behind a reverse proxy, to connect to a [sublayer]
(https://github.com/shenanigans/node-sublayer) instance, and can be built into your client
javascript with [browserify](http://browserify.org/).


####Table of Contents
**[Getting Started](#getting-started)
 * [On the Server](#on-the-server) locally or with a service layer
 * [In the Browser](#in-the-browser) and beyond

**[Actions](#actions)**
 * [Simple JSON Actions](#simple-json-actions) create a REST or RPC app that speaks JSON
 * [HTML Templates](#html-templates) automatically render a JSON response to HTML

**[Authentication](#authentication)**
 * [XSS Attack Prevention](#xss-attack-prevention) secure your users against hostile foreign domains

**[Server Events](#server-events)**
 * [User and Client Events](#user-and-client-events) get notified of user online status
 * [Live Connections](#live-connections) react to each new Socket.io connection
 * [Peer Requests](#peer-requests) connect users together directly with WebRTC

**[Deployment](#deployment)
 * [Remote Service Connector](#remote-service-connector) attach to a remote service layer
 * [Local Deployment](#local-deployment) run the service layer and app scripts together

**[Client Library](#client-library)**
 * [Actions](#actions) call home and any other substation server
 * [Peer To Peer](#peer-to-peer) call other users directly with WebRTC


Getting Started
---------------
`substation` is part of the [Node.js](https://nodejs.org/) ecosystem. You will need to install the
Node runtime and its accompanying `npm` package manager in order to author either server or client
applications.


### On the Server
`substation` does not provide a keepalive entry point. You must provide your own process upkeep
mechanism for ensuring that server sessions stay up. For an easy, battle-tested solution, try
[forever](https://github.com/foreverjs/forever).

Because there is no implied project structure to a `substation` service, there is no CLI tool. You
must write a small entry script which configures and launches the server. A variety of techniques
for doing so are supported. Here are some examples:
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
    require ('./lib/message/GET')
);

// activate a server
myServer.listen (function (err) {
    if (err) {
        console.error (err);
        return process.exit (1);
    }
    console.log ('myServer online!');
});

// use the monolith
substation.addAction (
    "POST",
    "/msg",
    require ('./lib/message/POST')
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

The loaded configuration file is not always necessary. `substation` comes preloaded with defaults
that will match most local deployments. If you are attaching to a remote service layer, your
configuration must contain at least as much information as this simple example:
```json
{
    "APIKey":       "oHfyCWW5nuPrPJC7kEJoDap1ACZmS9Q1E8sMtUbGALRV",
    "APIForward":   {
        "host":         "backend.mydomain.com"
    }
}
```

For more information on all the fun and exciting things you can put in your configuration, see [the
Deployment section](#deployment) or [view the generated docs]().


### In the Browser
The `substation` module provides vital client utilities when built into a [Browserify]
(http://browserify.org/) bundle. The best build technique is to require `substation` with the `-r`
flag to make it importable from the page.

The recommended way to hack on your client code is to use [Gulp](http://gulpjs.com/) to build the
client on changes. Install Gulp and a few other dependencies like so:
```shell
$ sudo npm install -g gulp
$ npm install gulp-util vinyl-source-stream browserify watchify
```

The new `gulp` command in your environment is expecting to find a `gulpfile.js` in the working
directory. Here's a simple example gulpfile:
```javascript
var gulp = require('gulp');
var gutil = require('gulp-util');
var source = require('vinyl-source-stream');
var browserify = require('browserify');
var watchify = require('watchify');

var bundler;
function bundle(){
     var stream = bundler
      .bundle()
      .on('error', gutil.log.bind (gutil, 'Browserify Error'))
      .pipe (source('bundle.js'))
      .pipe (gulp.dest('./static/build/'))
      ;
     stream.on ('end', function(){ gutil.log (gutil.colors.cyan ('built client library')); });
     return stream;
}

bundler = watchify (browserify({ cache: {}, packageCache: {} }));
bundler.require ('substation');
bundler.require ('./client/index.js', { expose:'client' });
bundler.on ('update', bundle);

gulp.task ('bundle', bundle);
gulp.task ('default', [ 'bundle' ]);
```

You may now load this bundle into a page with a normal `<script>` tag. Once loaded you may access
your module or the `substation` module from the page context at any time. When the server sends an
Event to this context, it will be emitted from the `substation` module but don't worry about missing
anything. Events will be queued and asynchronously released when the first listener is attached.
```javascript
var substation = require ('substation');
substation.on ('myEvent', myEventListener);
```

The `substation` module includes several useful tools and there's a lot more to learn! Head on over
to [the Client Library section](#client-library) to get started writing client bundles.


Actions
-------
Actions are similar to the routes in other frameworks, except they are accessible over [Socket.io]
(http://socket.io/) and automatically select whether to apply a template or just send JSON. If you
use the client library to perform an Action you need never know what transport was used.
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

// logs "using http"
// order of last two logging statements
// is not defined
```


### Simple JSON Actions
When JSON is requested or whenever a template is not available, JSON will be served. You can also
filter the query and body input to your action with a JSON Schema document. The query document is
always treated as a simple Object containing String properties.

```javascript
var substation = require ('substation');
var NewPost = new substation.Action ({
    // require user to be logged in
    Authentication: {
        isLoggedIn:     true
    },
    // filter the request body
    bodySchema:     {
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
            },
            format:     {
                type:       "array",
                items:      {
                    type:       "array",
                    items:      [
                        {
                            type:   'number',
                            minimum: 0
                        },
                        {
                            type:   'number',
                            minimum: 0
                        },
                        {
                            type:   'string',
                            enum:   [
                                'b',
                                'i',
                                'u',
                                's'
                            ]
                        }
                    ]
                }
            }
        }
    }
}, function (station, agent, request, reply) {

    // save the post
    var postID = request.params[0];
    // ...

    // content is reported to the request callback
    reply.content ({
        accepted:   true,
        totalPosts: postCount
    });

    // events are not associated with the request
    reply.event (
        'newPost',
        agent.user,
        postID
    );

    // close the Action
    reply.done (201);
});

// export the action on the monolith server
substation.addAction (
    'PUT',
    new RegExp ('/post/(\\d+)$')/,
    NewPost
);
```


### HTML Templates
When HTML is requested, `substation` attempts to select a template to render the reply's `content`
information into an HTML page. Templates are selected by the status code returned by the Action
Function. Mapping a template to an empty String sets a default template which is used when the
status code isn't found. If no template can be selected from the Action's configuration,
`substation` looks for one in its global configuration.
```javascript
var substation = require ('substation');
substation.configure ({
    template:   {
        'mydomain.com': {
            "":         rootTemplate,
            404:        rootTemplate_NotFound
        }
    }
});
var FooAction = new substation.Action ({
    template:   {
        200:        fooTemplate,
        403:        fooTemplate_Banned
    }
}, function (station, agent, request, reply) {
    // get and return a Foo
});
substation.addAction (
    GET,
    '/foo/',
    FooAction
);
```

The definition of a template is simple: a Function which accepts a context argument and optionally
a callback, and either returns an HTML String synchronously **or** passes an HTML String
asynchronously as the second argument of the callback. Most Node.js template libraries already
produce a suitable rendering Function. The author uses [Handlebars]
(http://handlebarsjs.com/reference.html#base-compile).

Here's a simplified version of the way `substation` calls your template:
```javascript
function renderContext (template, context, callback) {
    var done = false;
    try {
        var html = template (context, function (err, html) {
            if (done)
                return;
            if (err)
                return callback (err);
            callback (undefined, html);
        });
    } catch (err) {
        return callback (err);
    }
    if (html) {
        done = true;
        callback (undefined, html);
    }
}
```


Authentication
--------------
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
        reply.redirect ('/');
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
        reply.redirect ('/');
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


### XSS Attack Prevention
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

To secure your app against XSS attacks, require the `isDomestic` flag on any Action that can submit
or edit data on the User's behalf. You should also restrict Agents asking to view information
critical to the user's account.
```javascript
substation.addAction ({
    Authentication: {
        isDomestic:     true
    }
}, PostAction);
```


Server Events
-------------


### User and Client Events


### Live Connections


### Peer Requests


Deployment
----------


### Remote Service Connector


### Local Deployment


Client Library
--------------


### Actions


### Peer To Peer





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
