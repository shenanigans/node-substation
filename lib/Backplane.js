
var crypto = require ('crypto');
var cluster = require ('cluster');
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
}


/**     @local/class FauxSocket
    @development
    Wraps a clustered socket to attach a unique connection id and send to another process.
*/
function FauxSocket (socket, connectionID) {
    this.socket = socket;
    this.connectionID = connectionID;
}


/**     @member/FauxSocket#send

*/
FauxSocket.prototype.send = function (proto, info) {
    info.id = this.connectionID;
    this.socket.send (proto, info);
};


/**     @member/Function init
    Prepare the Backplane for communication with other server instances. If clustering, create
    master/worker connections. Ensure necessary indices on the database.
@callback
    @argument/Error|undefined err
*/
Backplane.prototype.init = function (callback) {
    // check local contact details

    var backplaneConnections = this.backplaneConnections;
    var self = this;
    var BackplaneCollection = this.parent.BackplaneCollection;
    var BackplaneHostsCollection = this.parent.BackplaneHostsCollection;

    if (cluster.isMaster) {
        if (this.config.clusterPort)
            this.clusterServer = nssocket.createServer (function (socket) {
                var connections = {};
                socket.data ([ 'live' ], function (info) {
                    var socket;
                    if (Object.hasOwnProperty.call (connections, info.id))
                        socket = connections[info.id];
                    else
                        socket = connections[info.id] = new FauxSocket (socket, info.id);
                    self.setLive (
                        info.user,
                        info.client,
                        socket,
                        info.status
                    );
                });
                socket.data ([ 'event' ], function (info) {
                    self.sendEvent (info.user, info.client, info.info, function (err, didReceive) {
                        var reply = {
                            user:       info.user,
                            client:     info.client,
                            id:         info.id
                        };
                        if (err)
                            reply.error = err;
                        else
                            reply.rec = didReceive;
                        socket.send ([ 'event', 'callback' ], reply);
                    });
                });
                socket.data ([ 'peer' ], function (info) {
                    self.sendPeer (info.user, info.client, info.info, function (err, didReceive) {
                        var reply = {
                            user:       info.user,
                            client:     info.client,
                            id:         info.id
                        };
                        if (err)
                            reply.error = err;
                        else
                            reply.rec = didReceive;
                        socket.send ([ 'peer', 'callback' ], reply);
                    });
                });
            });

        // database setup
        var backplaneID;
        async.parallel ([
            function (callback) {
                BackplaneCollection.ensureIndex (
                    { user:1, 'live.client':1 },
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
                        function (err, rec) {
                            if (err) {
                                console.log ('failed to access database');
                                return process.exit(1);
                            }
                            if (!rec || rec.BID == backplaneID)
                                return callback();
                            BackplaneCollection.remove ({ 'live.bid':rec.BID }, function (err) {
                                if (err) {
                                    console.log ('failed to access database');
                                    return process.exit(1);
                                }
                                callback();
                            });
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
                    self.peerConnection (info.userID, info.clientID, info.agent, info.info);
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
        return;
    }

    // worker process
    // connect to a master process socket
    var socket = new nssocket.NsSocket();
    socket.data ([ 'event' ], function (info) {
        self.fireEvent (info.userID, info.clientID, info.info);
    });
    socket.data ([ 'peer' ], function (info) {
        self.firePeerConnection (info.userID, info.clientID, info.agent, info.info);
    });
    socket.connect (this.config.clusterPort, function (err) {
        if (err) return callback (err);
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
            self.firePeerConnection (info.userID, info.clientID, info.agent, info.info);
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
Backplane.prototype.sendEvent = function (/* user, client, info, callback */) {
    var user, client, info, callback;
    switch (arguments.length) {
        case 2:
            user = arguments[0];
            info = arguments[1];
            break;
        case 3:
            user = arguments[0];
            info = arguments[1];
            callback = arguments[2];
            break;
        default:
            user = arguments[0];
            client = arguments[1]
            info = arguments[2];
            callback = arguments[3];
    }

    var config = this.config;
    var self = this;

    // hit local connections
    var didReceive = this.fireEvent (user, client, info);
    console.log ('fired local:', didReceive);

    if (client) {
        this.parent.BackplaneCollection.aggregate ([
            { $match:{ user:user, 'live.client':client } },
            { $unwind:'$live' },
            { $match:{ 'live.client':client } },
            { $project:{ live:true } }
        ], function (err, connections) {
            console.log (err, connections);
            async.each (connections, function (connection, callback) {
                var host = connection.live;
                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err) {
                        if (callback)
                            callback (err);
                        return;
                    }
                    backplaneSocket.send ([ 'event' ], info);
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
        });
        return;
    }

    this.parent.BackplaneCollection.findOne (
        { user:user },
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
                    backplaneSocket.send ([ 'event' ], info);
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
Backplane.prototype.sendPeerEvent = function (/* user, client, info, callback */) {
    var user, client, info, callback;
    switch (arguments.length) {
        case 2:
            user = arguments[0];
            info = arguments[1];
            break;
        case 3:
            user = arguments[0];
            info = arguments[1];
            callback = arguments[2];
            break;
        default:
            user = arguments[0];
            client = arguments[1]
            info = arguments[2];
            callback = arguments[3];
    }

    var config = this.config;
    var self = this;

    // hit local connections
    var didReceive = this.firePeerEvent (user, client, info);

    if (client) {
        this.parent.BackplaneCollection.aggregate ([
            { $match:{ user:user, 'live.client':client } },
            { $unwind:'$live' },
            { $match:{ 'live.client':client } },
            { $project:{ live:true } }
        ], function (err, connections) {
            console.log (err, connections);
            async.each (connections, function (connection, callback) {
                var host = connection.live;
                self.connect (host.address, host.port, host.bid, function (err, backplaneSocket) {
                    if (err) {
                        if (callback)
                            callback (err);
                        return;
                    }
                    backplaneSocket.send ([ 'peer' ], info);
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
        });
        return;
    }

    this.parent.BackplaneCollection.findOne (
        { user:user },
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
                    backplaneSocket.send ([ 'peer' ], info);
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


/**     @member/Function fireEvent
    @development
    Sends an incoming event message to the relavant local sockets.
*/
Backplane.prototype.fireEvent = function (user, client, info) {
    var connectionState = this.connectionState;
    var clientConnections;

    if (!Object.hasOwnProperty.call (connectionState, user))
        return false; // no connections for user
    if (client) {
        if (!Object.hasOwnProperty.call (connectionState[user], client))
            return false; // no connections for client
        clientConnections = connectionState[user][client];
        for (var i=0,j=clientConnections.length; i<j; i++)
            clientConnections[i].emit ('event', info);
        return true;
    }

    // send to every connection on every client
    var userClients = connectionState[user];
    var clientIDs = Object.keys (userClients);
    var sent = false;
    for (var i=0,j=clientIDs.length; i<j; i++) {
        clientConnections = userClients[clientIDs[i]];
        for (var k=0,l=clientConnections.length; k<l; k++) {
            sent = true;
            clientConnections[k].emit ('event', info);
        }
    }

    return sent;
};


/**     @member/Function firePeerEvent
    @development
    Sends an incoming peer connection message to the relavant local sockets.
*/
Backplane.prototype.firePeerEvent = function (user, client, info) {
    var connectionState = this.connectionState;
    var clientConnections;

    if (!Object.hasOwnProperty.call (connectionState, user))
        return false; // no connections for user
    if (client) {
        if (!Object.hasOwnProperty.call (connectionState[user], client))
            return false; // no connections for client
        clientConnections = connectionState[user][client];
        for (var i=0,j=clientConnections.length; i<j; i++)
            clientConnections[i].emit ('peer', info);
        return true;
    }

    // send to every connection on every client
    var userClients = connectionState[user];
    var clientIDs = Object.keys (userClients);
    var sent = false;
    for (var i=0,j=clientIDs.length; i<j; i++) {
        clientConnections = userClients[clientIDs[i]];
        for (var k=0,l=clientConnections.length; k<l; k++) {
            sent = true;
            clientConnections[k].emit ('peer', info);
        }
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
    var connectionState = this.connectionState;
    if (Object.hasOwnProperty.call (connectionState, user)) {
        if (Object.hasOwnProperty.call (connectionState[user], client)) {
            var connections = connectionState[user][client];
            if (status) {
                if (connections.indexOf (socket) < 0)
                    connections.push (socket);
                if (callback)
                    process.nextTick (callback);
                return;
            }
            var position = connections.indexOf (socket);
            if (position >= 0)
                connections.splice (position, 1);
            if (connections.length) {
                if (callback)
                    process.nextTick (callback);
                return;
            }
            delete connectionState[user][client];
            if (!Object.keys (connectionState[user]).length)
                delete connectionState[user];
        } else {
            if (!status) {
                if (callback)
                    process.nextTick (callback);
                return;
            }
            connectionState[user][client] = [ socket ];
        }
    } else {
        if (!status) {
            if (callback)
                process.nextTick (callback);
            return;
        }
        (connectionState[user] = {})[client] = [ socket ];
    }

    var BackplaneCollection = this.parent.BackplaneCollection;
    var address = this.config.BackplaneAddress;
    var port = this.config.port;
    var backplaneID = this.backplaneID;

    var update;
    if (status)
        update = { $push:{ live:this.record }, $inc:{ count:1 } };
    else
        update = { $pull:{ live:{ bid:backplaneID }, $inc:{ count:-1 } } };
    var parent = this.parent;
    BackplaneCollection.findAndModify (
        { user:user },
        { user:1 },
        update,
        { upsert:true, fields:{ live:{ $elemMatch:{ client:client } } } },
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
                    { user:user },
                    update,
                    { upsert:true, fields:{ live:{ $elemMatch:{ client:client } } } },
                    checkResult
                );
                return;
            }

            if (status) {
                if (oldRecord && !oldRecord.count)
                    parent.emit ('userOnline', user);
                parent.emit ('clientOnline', user, client);
            } else {
                if (!oldRecord || !oldRecord.count || oldRecord.count == 1)
                    parent.emit ('userOffline', user);
                parent.emit ('clientOffline', user, client);
            }
            if (callback)
                callback();
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
            query = { user:user, count:{ $gt:0 } };
            break;
        default:
            user = arguments[0];
            client = arguments[1];
            callback = arguments[2];
            query = { user:user, 'live.client':client };
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
