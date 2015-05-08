
var Common = require ('./Common');

/**     @class substation.Action.Reply
    @root
    Accumulates information and events to send to the client.
@callback exporter
    Receives information to ship to the user after [done](#done) is called.
    @argument/Number status
    @argument/Object info
*/
function Reply (exporter) {
    this.events = [];
    this.exporter = exporter;
}


/**     @member/Function event
    Fire an event on the client. May fire any number of the same event.
@throws/Error ClosedError
    More information cannot be written to the reply once [done](#done) is called.
@argument/String name
@argument content
    Any number of additional arguments containing JSON-serializable data to ship as arguments to the
    triggered event.
*/
Reply.prototype.event = function(){
    if (this.isClosed)
        return;
    this.events.push (Array.apply ([], arguments));
};


/**     @member/Function content
    Set content information for this reply. If called multiple times, the current content is deep
    copied, then additional content is deep merged in.
@throws/Error ClosedError
    More information cannot be written to the reply once [done](#done) is called.
@argument data
    Content information to send.
*/
Reply.prototype.content = function (data) {
    if (this.isClosed)
        return;
    if (!this.contentData)
        this.contentData = data;
    else {
        if (!this.wasCloned) {
            this.contentData = Common.clone (this.contentData);
            this.wasCloned = true;
        }
        Common.merge (this.contentData, data);
    }
};


/**     @member/Function done
    Send information and events to the client. Closes the reply to further content. Same as
    `close()`.
@argument/Number status
    @optional
    Specify a status code other than 200.
*/
Reply.prototype.done = function (status) {
    status = status || this.status || 200;
    if (this.isClosed)
        return;
    this.isClosed = true;

    this.exporter (status, this.events, this.contentData || {});
};


/**     @member/Function close
    Send information and events to the client. Closes the reply to further content. Same as
    `done()`.
*/
Reply.prototype.close = Reply.prototype.done;


/**     @member/Function redirect
    Set the `Redirect` header to a target url and inject an event called `redirect` passing the
    target url as an argument.
@argument/String targetURL
    This value is either set to the `location` header to redirect a browser client or passed to the
    `redirect` event on the application client.
*/
Reply.prototype.redirect = function (targetURL) {
    this.redirectURL = targetURL;
    this.status = 303;
};


/**     @member/Function clear
    Abandon accumulated information and events. Start over with an empty reply. No longer available
    once [done](#done) has been called.
*/
Reply.prototype.clear = function(){
    if (this.isClosed)
        throw new Error ('reply is already closed');
    this.wasCloned = false;
    this.events = [];
    delete this.content;
};


module.exports = Reply;
