
var crypto = require ('crypto');
var async = require ('async');
var nssocket = require ('nssocket');
var cachew = require ('cachew');
var Common = require ('./Common');
var uid = require ('infosex').uid.craft;


/**     @module/class substation.Backplane
    @root
    Trigger events on client machines. Selects remote connections by User or Client id String and
    routes events through the currently connected server instance(s). Manages live connection status
    records on the database and pools of connections to other server instances.
@argument/substation parent
@argument/substation.Configuration config
*/
function Backplane (parent, config) {
    this.parent = parent;
    this.config = config;

    this.connectionState = {};
    this.backplaneConnections = {};
    this.nextConnectionID = 1;
}


/**     @local/class FauxSocket
    @development
    Simulates a socket in another process by wrapping the cluster port socket, associating it with a
    unique ID and thus transparently routing messages through the cluster port and child process. In
    short, allows a socket on a child process to look as if it belonged to this process.
*/
function FauxSocket (socket, SID, agent) {
    this.socket = socket;
    this.SID = SID;
    this.agent = agent;
}


/**     @member/FauxSocket#send

*/
FauxSocket.prototype.emit = function (name, event) {
    var eventDoc = {
        SID:    this.SID,
        event:  event
    };
    this.socket.send ([ name ], eventDoc);
};


/**     @member/Function init
    Prepare the Backplane for communication with other server instances. If clustering, create
    master/worker connections. Ensure necessary indices on the database.
@callback
    @argument/Error|undefined err
*/
Backplane.prototype.init = function (callback) {
    var backplaneConnections = this.backplaneConnections;
    var self = this;
    var BackplaneCollection = this.parent.BackplaneCollection;
    var BackplaneHostsCollection = this.parent.BackplaneHostsCollection;

    if (this.config.cacheLinks)
        this.linkCache = new cachew.ChainCache (
            this.config.linkCacheTimeout,
            this.config.cacheLinks
        );

    var backplaneID;
    async.parallel ([
        function (callback) {
            BackplaneCollection.ensureIndex (
                { _id:1, 'live.client':1 },
                { unique:true, name:'User/Client' },
                callback
            );
        },
        function (callback) {
            BackplaneCollection.ensureIndex (
                { _id:1, 'link.client':1 },
                { unique:true, name:'User/Client' },
                callback
            );
        },
        function (callback) {
            BackplaneCollection.ensureIndex (
                { created:1 },
                { name:'CreationTime' },
                callback
            );
        },
        function (callback) {
            BackplaneCollection.ensureIndex (
                { 'live.bid':1 },
                { name:'BackplaneID' },
                callback
            );
        },
        function (callback) {
            BackplaneHostsCollection.ensureIndex (
                { address:1, port:1 },
                { name:'NetworkLocation' },
                callback
            );
        },
        // establish BID, destroy stranded BID
        function (callback) {
            uid (function (id) {
                backplaneID = id;
                self.backplaneID = backplaneID;
                BackplaneHostsCollection.findAndModify (
                    { address:self.BackplaneAddress, port:self.config.port },
                    { address:1, port:1 },
                    { $set:{ BID:backplaneID } },
                    { upsert:true },
                    function (err, oldHost) {
                        if (err) {
                            console.log ('failed to access database', err);
                            return process.exit(1);
                        }
                        if (!oldHost || oldHost.BID == backplaneID)
                            return callback();
                        BackplaneCollection.find (
                            { 'live.bid':oldHost.BID },
                            function (err, cursor) {
                                if (err) {
                                    console.log ('failed to access database', err);
                                    return process.exit(1);
                                }
                                cursor.each (function (err, rec) {
                                    if (err) {
                                        console.log ('failed to access database', err);
                                        return process.exit(1);
                                    }

                                    if (!rec) return callback();

                                    var live = rec.live;
                                    if (!live || !live.length) return;
                                    var count = 0;
                                    for (var i=0,j=live.length; i<j; i++)
                                        if (live[i].bid == oldHost.BID)
                                            count--;
                                    if (!count) return;
                                    BackplaneCollection.update (
                                        { _id:rec._id },
                                        {
                                            $pull:  { live:{ bid:oldHost.BID } },
                                            $inc:   { count:count }
                                        },
                                        { w:0 }
                                    );
                                });
                            }
                        );
                    }
                );
            });
        }
    ], function (err) {
        if (err)
            return callback (err);

        // create a reusable subdocument that describes this Backplane instance
        self.record = {
            address:    self.BackplaneAddress,
            port:       self.config.port,
            bid:        backplaneID
        };

        // open event receiver port
        self.server = nssocket.createServer (function (socket) {
            socket.data ([ 'event' ], function (info) {
                self.sendEvent (info.userID, info.clientID, info.info);
            });
            socket.data ([ 'peer' ], function (info) {
                self.firePeerEvent (info.userID, info.clientID, info.agent, info.info);
            });
            socket.data ([ 'open' ], function (info) {
                if (!Object.hasOwnProperty.call (backplaneConnections, info.id)) {
                    backplaneConnections[info.id] = socket;
                    return;
                }

                var existing = backplaneConnections[info.id];
                if (existing.locked || info.fortune < existing.fortune)
                    return socket.close();
                if (info.fortune == existing.fortune)
                    return crypto.randomBytes (4, function sendFortune (err, fortune) {
                        if (err)
                            return crypto.randomBytes (4, sendFortune);
                        socket.data ([ 'open' ], {
                            id:         backplaneID,
                            fortune:    fortune.readUInt32 (fortune)
                        });
                    });

                existing.close();
            });
        });
        callback();
    });
};


/**     @member/Function connect
    Establish a connection to a remote Backplane, negotiating colisions if necessary.
@argument/String address
@argument/Number port
@argument/String backplaneID
@callback
    @argument/Error|undefined err
    @argument/nssocket|undefined socket
*/
Backplane.prototype.connect = function (address, port, backplaneID, callback) {
    var backplaneConnections = this.backplaneConnections;
    var self = this;

    crypto.randomBytes (4, function createFortune (err, fortune) {
        if (err)
            return crypto.randomBytes (4, createFortune);

        if (Object.hasOwnProperty.call (backplaneConnections, backplaneID)) {
            var socket = backplaneConnections[backplaneID];
            return process.nextTick (function(){ callback (undefined, socket); });
        }

        var socket = new nssocket.NsSocket();
        socket.data ([ 'event' ], function (info) {
            self.fireEvent (info.userID, info.clientID, info.info);
        });
        socket.data ([ 'peer' ], function (info) {
            self.firePeerEvent (info.userID, info.clientID, info.agent, info.event, info.exclude);
        });
        socket.data ([ 'open' ], function (info) {
            // this always means a colision occured
            crypto.randomBytes (4, function compareFortune (err, fortune) {
                if (err)
                    return crypto.randomBytes (4, compareFortune);
                socket.send ([ 'open' ], { id:backplaneID, fortune:fortune.readUInt32() });
                if (fortune == info.fortune) // another colision!
                    return;
                if (fortune > info.fortune) {
                    if (Object.hasOwnProperty.call (backplaneConnections, backplaneID))
                        backplaneConnections[backplaneID].close();
                    backplaneConnections[backplaneID] = socket;
                    return callback (undefined, socket);
                }

                if (!Object.hasOwnProperty.call (backplaneConnections, backplaneID)) {
                    backplaneConnections[backplaneID] = socket;
                    return callback (undefined, socket);
                }

                socket.close();
                return callback (undefined, backplaneConnections[backplaneID]);
            });
        });

        socket.connect (port, address, function (err) {
            if (err) return callback (err);
            socket.send ([ 'open' ], { id:backplaneID, fortune:fortune });
        });
    });
};



/**     @member/Function sendEvent
    Trigger an event on one or more client machines.
@argument/String user
@argument/String client
    @optional
    Fires events on all live sessions attached to a specific client on all `substation` instances.
    If ommitted, all active live sessions belonging to the `user` receive events.
@argument/Array eventInfo
    Event arguments as an Array.
@callback
    @argument/Error|undefined err
*/
Backplane.prototype.sendEvent = function (user, client, event, callback) {
    var config = this.config;
    var self = this;

    // hit local connections
    var didReceive = this.fireEvent (user, client, event);

    if (client) {
        this.parent.BackplaneCollection.aggregate ([
            { $match:{ _id:user, 'live.client':client } },
            { $project:{ live:true } },
            { $unwind:'$live' },
            { $match:{ 'live.client':client } }
        ], function (err, connections) {
            async.each (connections, function (connection, callback) {
                var host = connection.live;
                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err) {
                        if (callback)
                            callback (err);
                        return;
                    }
                    var eventID = self.nextEventID++;
                    backplaneSocket.send ([ 'sendEvent' ], {
                        user:       user,
                        client:     client,
                        event:      event
                    });
                    didReceive = true;
                });
            }, function (err) {
                if (err) {
                    if (callback)
                        callback (err);
                    return;
                }
                if (callback)
                    callback (undefined, didReceive);
            });
        });
        return;
    }

    this.parent.BackplaneCollection.findOne (
        { _id:user },
        function (err, userRecord) {
            if (err) return callback (err);
            if (!userRecord) {
                if (callback)
                    callback (undefined, false);
                return;
            }
            if (!userRecord.live || !userRecord.live.length) {
                if (callback)
                    callback (undefined, didReceive);
                return;
            }
            async.each (userRecord.live, function (host, callback) {
                if (host.address == self.record.address && host.port == self.record.port)
                    // that's just us
                    return callback();

                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err) {
                        if (callback)
                            callback (err);
                        return;
                    }
                    backplaneSocket.send ([ 'event' ], event);
                    didReceive = true;
                    if (callback)
                        callback();
                });
            }, function (err) {
                if (err) {
                    if (callback)
                        callback (err);
                    return;
                }
                if (callback)
                    callback (undefined, didReceive);
            });
        }
    );
};


/**     @member/Function routePeerEvent

*/
Backplane.prototype.routePeerEvent = function (event, agent, callback) {
    if (event.from && event.from === event.to) {
        if (callback)
            process.nextTick (callback);
        return;
    }
    var linkRec, sender, recipient;
    var linkCache = this.linkCache;
    var self = this;

    function shipInit (err, linkRec) {
        if (err) {
            console.log ('database error while shipping offer inits', err);
            return;
        }
        if (!linkRec) // socket has already sent or received an init
            return;

        if (linkCache)
            linkCache.set (event.token, linkRec);
        self.sendPeerEvent (
            recipient.user,
            recipient.client,
            { token:event.token, from:event.from, init:true, query:sender.query },
            linkRec.init,
            function (err, didReceive) {
                if (didReceive)
                    return;

                // nobody awake to connect to link
                // cull the link record and subdocs
                // console.log ('cull');
                BackplaneCollection.update (
                    { _id:agent.user },
                    { $pull:{ link:{
                        client:     link.client,
                        tgtUser:    link.tgtUser,
                        tgtClient:  link.tgtClient
                    } } },
                    function (err) {
                        if (err) {
                            console.log ('joinLinks subdoc cull error', err);
                            return;
                        }
                    }
                );
                BackplaneCollection.update (
                    { _id:link.tgtUser },
                    { $pull:{ link:{
                        client:     link.tgtClient,
                        tgtUser:    agent.user,
                        tgtClient:  link.client
                    } } },
                    function (err) {
                        if (err) {
                            console.log ('joinLinks subdoc cull error', err);
                            return;
                        }
                    }
                );
                self.parent.LinksCollection.update (
                    { _id:link.token },
                    { $set:{ closed:true } },
                    function (err) {
                        if (err) {
                            console.log ('joinLinks record cull error', err);
                            return;
                        }
                    }
                );
            }
        );
    }

    // cached token record?
    if (linkCache && (linkRec = linkCache.get (event.token))) {
        // choose recipient
        // if client specified, worry about case: user_A/client_1 -> user_A/client_2
        if (linkRec.party[0].user == agent.user) {
            sender = linkRec.party[0];
            recipient = linkRec.party[1];
            if (sender.client && sender.client != agent.client) {
                sender = recipient;
                recipient = linkRec.party[0];
            }
        } else {
            recipient = linkRec.party[0];
            sender = linkRec.party[1];
        }
        if (sender.user != agent.user)
            // token doesn't belong to this user
            return;
        if (sender.client && sender.client != agent.client)
            // token doesn't belong to this client
            return;

        event.query = sender.query;
        self.sendPeerEvent (
            recipient.user,
            recipient.client,
            event,
            undefined,
            callback
        );

        // any chance we need to ship additional `init` messages for this event?
        if (!event.ICE && (
            !linkRec.init
         || !Object.hasOwnProperty.call (linkRec.init, event.from)
        )) { // confirm with the db and lock the sender
            self.parent.LinksCollection.findAndModify (
                { _id:event.token, init:{ $ne:event.from }, closed:false },
                { _id:1 },
                { $push:{ init:{ $each:[ event.from ], $slice:-30 } } },
                shipInit
            );
        }

        return;
    }

    // ask the database about the presented token
    this.parent.LinksCollection.findOne ({ _id:event.token, closed:false }, function (err, linkRec) {
        if (err || !linkRec)
            return;

        // choose recipient
        // if client specified, worry about case: user_A/client_1 -> user_A/client_2
        if (linkRec.party[0].user == agent.user) {
            sender = linkRec.party[0];
            recipient = linkRec.party[1];
            if (sender.client && sender.client != agent.client) {
                sender = recipient;
                recipient = linkRec.party[0];
            }
        } else {
            recipient = linkRec.party[0];
            sender = linkRec.party[1];
        }
        if (sender.user != agent.user)
            // token doesn't belong to this user
            return;
        if (sender.client && sender.client != agent.client)
            // token doesn't belong to this client
            return;

        if (linkCache)
            linkCache.set (event.token, linkRec);

        event.query = sender.query;
        self.sendPeerEvent (
            recipient.user,
            recipient.client,
            event,
            undefined,
            callback
        );

        // any chance we need to ship additional `init` messages for this event?
        if (!event.ICE && (
            !linkRec.init
         || !Object.hasOwnProperty.call (linkRec.init, event.from)
        )) // confirm with the db and lock the sender
            self.parent.LinksCollection.findAndModify (
                { _id:event.token, init:{ $ne:event.from }, closed:false },
                { _id:1 },
                { $push:{ init:{ $each:[ event.from ], $slice:-30 } } },
                shipInit
            );
    });
}


/**     @member/Function sendPeerEvent
    Attempt to negotiate a WebRTC connection with a client device holding an active session.
    Optionally perform the [configured authentication method]
    (substation.Configuration.peerAuthentication) with an [Agent](substation.Action(agent) argument
    before allowing the connection to proceed.
@argument/String user
@argument/String client
@argument/substation.Authentication.Agent agent
    @optional
@argument/Object info
@callback
    @argument/Error|undefined err
*/
Backplane.prototype.sendPeerEvent = function (user, client, event, exclude, callback) {
    var config = this.config;
    var self = this;

    // hit local connections
    var didReceive = this.firePeerEvent (user, client, event, exclude);
    if (event.to && didReceive)
        return process.nextTick (function(){ callback (undefined, true); });

    if (client) {
        this.parent.BackplaneCollection.aggregate ([
            { $match:{ _id:user, 'live.client':client } },
            { $unwind:'$live' },
            { $match:{ 'live.client':client } },
            { $project:{ live:true } }
        ], function (err, connections) {
            async.each (connections, function (connection, callback) {
                var host = connection.live;
                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err) {
                        console.log ('sendPeerEvent Backplane connection error', err);
                        return;
                    }
                    backplaneSocket.send ([ 'peer' ], { event:event, exclude:exclude });
                    didReceive = true;
                });
            }, function (err) {
                if (err) {
                    console.log ('sendPeerEvent aggregation error', err);
                    return callback (err);
                }
                callback (undefined, true);
            });
        });
        return;
    }

    this.parent.BackplaneCollection.findOne (
        { _id:user },
        function (err, userRecord) {
            if (err) return callback (err);
            if (!userRecord)
                return callback (undefined, didReceive);
            if (!userRecord.live || !userRecord.live.length)
                return callback (undefined, didReceive);

            async.each (userRecord.live, function (host, callback) {
                if (host.address == self.record.address && host.port == self.record.port)
                    // that's this Backplane node
                    return callback();

                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err)
                        return callback (err);
                    backplaneSocket.send ([ 'peer' ], info);
                    callback();
                });
            }, function (err) {
                if (err)
                    return callback (err);
                callback (undefined, true);
            });
        }
    );
};


/**     @member/Function fireEvent
    @development
    Sends an incoming event message to the relavant local sockets.
*/
Backplane.prototype.fireEvent = function (user, client, event) {
    var connectionState = this.connectionState;
    var clientConnections;

    if (!Object.hasOwnProperty.call (connectionState, user))
        return false; // no connections for user
    if (client) {
        if (!Object.hasOwnProperty.call (connectionState[user], client))
            return false; // no connections for client
        clientConnections = connectionState[user][client];
        for (var i=0,j=clientConnections.length; i<j; i++)
            clientConnections[i].emit ('event', event);
        return true;
    }

    // send to every connection on every client
    var userClients = connectionState[user];
    var clientIDs = Object.keys (userClients);

    var sent = false;
    for (var i=0,j=clientIDs.length; i<j; i++) {
        clientConnections = userClients[clientIDs[i]];
        if (clientConnections.length)
            sent = true;
        for (var k=0,l=clientConnections.length; k<l; k++)
            clientConnections[k].emit ('event', event);
    }
    return sent;
};


/**     @member/Function firePeerEvent
    @development
    Sends an incoming peer connection message to the relavant local sockets.
*/
Backplane.prototype.firePeerEvent = function (user, client, event, exclude) {
    var connectionState = this.connectionState;
    var clientConnections;

    if (!Object.hasOwnProperty.call (connectionState, user))
        return false; // no connections for user
    if (client) {
        if (!Object.hasOwnProperty.call (connectionState[user], client))
            return false; // no connections for client
        clientConnections = connectionState[user][client];
        if (event.to) {
            for (var i=0,j=clientConnections.length; i<j; i++)
                if (clientConnections[i].SID == event.to) {
                    clientConnections[i].emit ('peer', event);
                    return true;
                }
        } else if (exclude) {
            for (var i=0,j=clientConnections.length; i<j; i++)
                if (exclude.indexOf (clientConnections[i].SID) < 0)
                    clientConnections[i].emit ('peer', event);
        } else
            for (var i=0,j=clientConnections.length; i<j; i++)
                clientConnections[i].emit ('peer', event);
        return true;
    }

    // send to every connection on every client
    var userClients = connectionState[user];
    var clientIDs = Object.keys (userClients);

    // filter for one connection
    if (event.to) {
        for (var i=0,j=clientIDs.length; i<j; i++) {
            clientConnections = userClients[clientIDs[i]];
            for (var k=0,l=clientConnections.length; k<l; k++)
                if (clientConnections[k].SID == event.to) {
                    clientConnections[k].emit ('peer', event);
                    return true;
                }
        }
        return false;
    }

    var sent = false;
    if (exclude) {
        for (var i=0,j=clientIDs.length; i<j; i++) {
            clientConnections = userClients[clientIDs[i]];
            for (var k=0,l=clientConnections.length; k<l; k++)
                if (exclude.indexOf (clientConnections[k].SID) < 0) {
                    sent = true;
                    clientConnections[k].emit ('peer', event);
                }
        }
        return sent;
    }

    for (var i=0,j=clientIDs.length; i<j; i++) {
        clientConnections = userClients[clientIDs[i]];
        if (clientConnections.length)
            sent = true;
        for (var k=0,l=clientConnections.length; k<l; k++)
            clientConnections[k].emit ('peer', event);
    }

    return sent;
};


/**     @member/Function setLive
    @development
    Notify that a live session has gone on or offline. Pushes status updates to the database.
@argument/String user
@argument/String client
@argument/Boolean status
*/
Backplane.prototype.setLive = function (user, client, socket, status, callback) {
    var self = this;

    var connectionState = this.connectionState;
    var BackplaneCollection = this.parent.BackplaneCollection;

    // attach a new connection to an ongoing link
    function joinLinks (err, bpRec) {
        if (!bpRec || !bpRec.link || !bpRec.link.length) {
            if (callback)
                callback();
            return;
        }
        console.log ('joinLinks', bpRec.link);
        async.each (bpRec.link, function (link, callback) {
            var eventMsg = {
                token:  link.token,
                from:   socket.SID,
                init:   true
            };
            self.parent.LinksCollection.update (
                { _id:link.token, init:{ $ne:socket.SID }, closed:false },
                { $push:{ init:{ $each:[ socket.SID ], $slice:-30 } } },
                function (err) {
                    if (err)
                        return callback (err);

                    self.routePeerEvent (eventMsg, socket.agent, function (err, didReceive) {
                        if (err)
                            console.log ('routePeerEvent error', err);

                        callback();
                        if (didReceive)
                            return;

                        // nobody received the link rejoin request
                        // cull the Link record and subdocs on each BPHost record
                        self.parent.logger.info ("Link culled", { token:link.token });
                        BackplaneCollection.update (
                            { _id:socket.agent.user },
                            { $pull:{ link:{
                                client:     link.client,
                                tgtUser:    link.tgtUser,
                                tgtClient:  link.tgtClient
                            } } },
                            function (err) {
                                if (err) {
                                    console.log ('joinLinks subdoc cull error', err);
                                    return;
                                }
                            }
                        );
                        BackplaneCollection.update (
                            { _id:link.tgtUser },
                            { $pull:{ link:{
                                client:     link.tgtClient,
                                tgtUser:    socket.agent.user,
                                tgtClient:  link.client
                            } } },
                            function (err) {
                                if (err) {
                                    console.log ('joinLinks subdoc cull error', err);
                                    return;
                                }
                            }
                        );
                        self.parent.LinksCollection.update (
                            { _id:link.token },
                            { $set:{ closed:true } },
                            function (err) {
                                if (err) {
                                    console.log ('joinLinks record cull error', err);
                                    return;
                                }
                            }
                        );
                    });
                }
            );
        }, function (err) {
            if (err) {
                if (callback)
                    callback (err);
                return;
            }
            if (callback)
                callback();
        });
    }

    // local connection info already present?
    if (Object.hasOwnProperty.call (connectionState, user)) {
        if (Object.hasOwnProperty.call (connectionState[user], client)) {
            // found active local connections for Client
            var connections = connectionState[user][client];


            if (status) {
                if (connections.indexOf (socket) < 0)
                    connections.push (socket);
                if (callback)
                    process.nextTick (callback);
                BackplaneCollection.findOne ({ _id:user }, { link:true }, joinLinks);
                return;
            }

            // drop local connection
            var position = connections.indexOf (socket);
            if (position >= 0)
                connections.splice (position, 1);
            if (connections.length) {
                if (callback)
                    process.nextTick (callback);
                BackplaneCollection.findOne ({ _id:user }, { link:true }, joinLinks);
                return;
            }

            // all local connections offline, notify database
            delete connectionState[user][client];
            if (!Object.keys (connectionState[user]).length)
                delete connectionState[user];
        } else {
            // User is already live but Client isn't
            if (!status) {
                if (callback)
                    process.nextTick (callback);
                return;
            }
            connectionState[user][client] = [ socket ];
        }
    } else {
        // User is not live on this server instance yet
        if (!status) {
            if (callback)
                process.nextTick (callback);
            return;
        }
        (connectionState[user] = {})[client] = [ socket ];
    }

    var address = this.config.BackplaneAddress;
    var port = this.config.port;
    var backplaneID = this.backplaneID;

    var update;
    if (status)
        update = { $push:{ live:this.record }, $inc:{ count:1 } };
    else
        update = { $pull:{ live:{ bid:backplaneID } }, $inc:{ count:-1 } };
    var parent = this.parent;
    BackplaneCollection.findAndModify (
        { _id:user },
        { user:1 },
        update,
        { upsert:true, fields:{ link:true } },
        function checkResult (err, oldRecord) {
            if (err) {
                console.log ('err', err);
                if (callback)
                    callback (err);
                return;
            }

            var statusNow =
                Object.hasOwnProperty.call (connectionState, user)
             && Object.hasOwnProperty.call (connectionState[user], client)
             ;
            if (status != statusNow) {
                status = statusNow;
                if (status)
                    update = { $push:{ live:this.record }, $inc:{ count:1 } };
                else
                    update = { $pull:{ live:{ bid:backplaneID }, $inc:{ count:-1 } } };
                BackplaneCollection.findAndModify (
                    { _id:user },
                    update,
                    { upsert:true, fields:{ live:{ $elemMatch:{ client:client } } } },
                    checkResult
                );
                return;
            }

            if (status) {
                if (oldRecord) {
                    if (oldRecord.link && oldRecord.link.length)
                        joinLinks (undefined, oldRecord);
                    if (!oldRecord.count)
                        parent.emit ('userOnline', user);
                }
                parent.emit ('clientOnline', user, client);
            } else {
                if (!oldRecord) {
                    parent.emit ('clientOffline', client);
                    parent.emit ('userOffline', user);
                    return;
                }
                var cullLinks;
                if (!oldRecord.count || oldRecord.count == 1) {
                    parent.emit ('userOffline', user);
                    cullLinks = oldRecord.link;
                    console.log ('offline cull', cullLinks);
                }
                if (!oldRecord.live || !oldRecord.live.length) {
                    parent.emit ('clientOffline', user, client);
                    if (!cullLinks) {
                        cullLinks = [];
                        if (!oldRecord || !oldRecord.link || !oldRecord.link.length)
                            return;
                        for (var i=0,j=oldRecord.link.length; i<j; i++)
                            if (oldRecord.link[i].client == client)
                                cullLinks.push (oldRecord.link[i]);
                    }
                }

                if (!cullLinks || !cullLinks.length)
                    return;

                cullLinks.forEach (function (link) {
                    if (link.client && link.client != client)
                        return;
                    // cull the link record and subdocs
                    BackplaneCollection.update (
                        { _id:user },
                        { $pull:{ link:{
                            client:     link.client,
                            tgtUser:    link.tgtUser,
                            tgtClient:  link.tgtClient
                        } } },
                        function (err) {
                            if (err) {
                                console.log ('setLive subdoc cull error', err);
                                return;
                            }
                        }
                    );
                    BackplaneCollection.update (
                        { _id:link.tgtUser },
                        { $pull:{ link:{
                            client:     link.tgtClient,
                            tgtUser:    user,
                            tgtClient:  link.client
                        } } },
                        function (err) {
                            if (err) {
                                console.log ('setLive subdoc cull error', err);
                                return;
                            }
                        }
                    );
                    self.parent.LinksCollection.update (
                        { _id:link.token },
                        { $set:{ closed:true } },
                        function (err) {
                            if (err) {
                                console.log ('setLive record cull error', err);
                                return;
                            }
                        }
                    );
                });
            }
        }
    );
};


/**     @member/Function isActive

@argument/String user
@argument/String client
    @optional
@callback
*/
Backplane.prototype.isActive = function (/* user, client, callback */) {
    var user, client, callback, query;
    switch (arguments.length) {
        case 2:
            user = arguments[0];
            callback = arguments[1];
            query = { _id:user, count:{ $gt:0 } };
            break;
        default:
            user = arguments[0];
            client = arguments[1];
            callback = arguments[2];
            query = { _id:user, 'live.client':client };
    }

    this.parent.BackplaneCollection.findOne (
        query,
        { _id:true },
        function (err, rec) {
            if (err)
                return callback (err);

            callback (undefined, Boolean (rec));
        }
    );
};

module.exports = Backplane;
