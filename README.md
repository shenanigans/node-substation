
node-substation
---------------
A realtime application gateway and authentication provider for [Node.js](https://nodejs.org/) and
[MongoDB](https://www.mongodb.org/).
 * manages sessions and cookies transparently
 * exposes robust XSS protection by default
 * obfuscates [Socket.io](http://socket.io/) over your REST api
 * routes events to live-connected users anywhere on the cluster
 * automates WebRTC connections between authenticated users


Getting Started
===============
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


Authentication
==============
`substation` features an uncommon dual-layer authentication scheme, intended to accomodate
origin-specific policies by default. Each unique user ID owns any number of unique client IDs,
representing the individual devices used to access your application. You *must* have a User *and* a
Client to log in.

A common example of this scheme implemented in the wild is [Steam](http://store.steampowered.com/).
When connecting to a Steam account from a "new computer" the email-validation stage must be repeated
using a short alphanumeric code.

`substation` has no opinion about how Clients should be validated, whether new Clients need to be
confirmed, etc. You are only required to generate a Client ID to log in as and ask `substation` to
[declare the user active](substation.Agent#setActive).
