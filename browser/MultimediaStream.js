
var MediaStream =
    window.MediaStream
 || window.mozMediaStream
 || window.webkitMediaStream
 ;
var getterName =
    window.navigator.getUserMedia ? 'getUserMedia'
  : window.navigator.webkitGetUserMedia ? 'webkitGetUserMedia'
  : window.navigator.mozGetUserMedia ? 'mozGetUserMedia'
  : undefined;

var EventEmitter = require ('events').EventEmitter;
var inherit = require ('./inherit');


/**     @property/Function substation.getUserMedia
    A wrapped version of the native getUserMedia function that produces [MultimediaStream]
    (substation.MultimediaStream) instances with a more modern callback style.
@argument/Object constraints
@callback
    @argument/Error|undefined err
        If multimedia streams are not available or have been refused by the user, an Error is
        returned. Because Chrome has a tendency to sporadically throw `DevicesNotFoundError`
        incorrectly, multiple attempts will be made whenever this `Error.name` is encountered.
    @argument/substation.MultimediaStream
        @optional
        The multimedia stream approved by the user, unless they refused or an error occured.
*/
function getUserMedia (constraints, callback) {
    if (!getterName)
        throw new Error ('getUserMedia not available');
    constraints = constraints || { audio:true, video:true };
    var attempts = 5;
    (function getMedia(){
        navigator[getterName] (constraints, function (stream) {
            callback (undefined, new MultimediaStream (stream));
        }, function (err) {
            if (err.name == 'DevicesNotFoundError' && --attempts)
                return setTimeout (getMedia, 150);
            callback (err);
        });
    })();
}


/**     @property/class substation.MultimediaStream
    @root
    @super events.EventEmitter
    @api
    Wraps the native [MediaStream]() api for multimedia content streams with something a little more
    modern and comfortable. Automatic handling of "replacement streams" allows WebRTC streams to
    persist across connection renegotiations in a transparent manner. To consume a
    `MultimediaStream` simply [get an Object URL](#toURL) and set it to the `src` attribute of a
    media [Element](). It will be automagically kept up to speed on any changes to the [native
    stream](MediaStream).

    In this example, an incoming stream from a [WebRTC peer](substation.Peer) is consumed. Note that
    because multiple contexts may receive this stream, it's usually not the best idea to consume a
    stream without asking the user.

    ```javascript
    peerConnection.on ('stream', function (stream) {
        var mediaElem = document.createElement ('video');
        mediaElem.setAttribute ('src', stream.toURL());
        document.getElementById ('MediaContainer')
            .appendChild (mediaElem)
            ;
    });
    ```
@member/MediaStream stream
    The wrapped native [MediaStream]().
@member/Boolean closed
    `true` for Streams that have been closed. A more fashionable name for `ended`.
@member/Boolean ended
    `true` for Streams that have been closed. The less fashionable name for `closed`.
@member/String id
    Native String GUID assigned to the stream. No other MediaStream in the universe **should** have
    the same one of these. However, user media support is still clownshoes in all browsers so expect
    to see repetitive `id` Strings such as `"default"` or `""` for streams from [getUserMedia]
    (substation.getUserMedia).
@event open
    The underlying [MediaStream]() has signaled that it is ready to begin sending content. New event
    listeners will fire immediately if the stream is currently open. This even will not fire again
    unless a [close](+close) event has occured.
@event close
    The underlying [MediaStream]() has closed and probably will not continue.
@event addTrack
    A media track was added to the stream.
@event removeTrack
    A media track was removed from the stream.
*/
function MultimediaStream (native, id) {
    EventEmitter.call (this);
    this.stickies = {};
    var self = this;
    this.on ('addListener', function (event, listener) {
        if (Object.hasOwnProperty.call (self.stickies, event))
            listener (self.stickies[event]);
    });
    this.stream = native;
    this.started = false;
    this.closed = this.ended = Boolean (native.ended);
    this.id = id || native.id;
    this.assimilateNative (native);
}
inherit (MultimediaStream, EventEmitter);
MultimediaStream.getUserMedia = getUserMedia;
module.exports = MultimediaStream;

/**     @member/Function addReplacement
    Register a "replacement stream" that will be used next when the underlying stream closes. This
    is used to keep streams avaiilable during connection-reversing WebRTC renegotiations.
@argument/MediaStream replacement
*/
MultimediaStream.prototype.addReplacement = function (replacement) {
    if (this.replacement)
        rejectNative (this.replacement);
    this.assimilateNative (replacement);
    this.replacement = replacement;
    if (!this.state)
        this.swapNatives();
};

/**     @member/Function swapNatives
    @private
    Swap [this.replacement](#replacement) into every `<video>` [Element]() currently playing
    [this.stream](#stream), then disable the current stream's event listeners and swap the
    replacement into `this.stream`.
*/
/**     @event swap
    If the underlying stream is exchanged for another, for example during a WebRTC renegotiation,
    this event is emitted just before automatic `src` swapping occurs. It's useful when you're
    consuming streams outside of a `<video>` or `<audio>` tag.
@argument/MediaStream newNative
    The new native stream being swapped in.
*/
MultimediaStream.prototype.swapNatives = function(){
    if (!this.replacement)
        return;

    rejectNative (this.stream);
    this.stream = this.replacement;
    delete this.replacement;

    this.emit ('swap', this.stream);

    if (!this.url) // if nobody has called toURL yet, nobody is consuming this stream
        return;

    var elems = [];
    elems.push.apply (elems, window.document.getElementsByTagName ('video'));
    elems.push.apply (elems, window.document.getElementsByTagName ('audio'));
    if (!elems.length) return;

    var oldURL = this.url;
    var newURL = this.url = URL.createObjectURL (this.stream);
    for (var i=0,j=elems.length; i<j; i++)
        if (elems[i].getAttribute ('src') == oldURL)
            elems[i].setAttribute ('src', newURL);
};

/**     @member/Function startNative
    @private
    Called when a native [MediaStream's](MediaStream) [onstarted](MediaStream@started) event occurs.
    Emits the [open](+open) event if it has not occured or if the [closed](+closed) event has
    been emitted. Whenever a replacement native starts, it is swapped in immediately.
@argument/MediaStream native
    The [MediaStream]() that emitted this event.
*/
MultimediaStream.prototype.startNative = function (native) {
    if (this.replacement === native)
        this.swapNatives();
    else if (this.stream !== native) // unkown stream
        return;
    if (this.state)
        return;
    this.stickies.open = [ this ];
    delete this.stickies.close;
    this.emit ('open', this);
};

/**     @member/Function endNative
    @private
    Called when a native [MediaStream's](MediaStream) [onended](MediaStream@ended) event occurs.
    Emits the [close](+close) event if it has not occured or if the [open](+open) event has been
    emitted. When replacement natives close, nobody hears.
@argument/MediaStream native
    The [MediaStream]() that emitted this event.
*/
MultimediaStream.prototype.endNative = function (native) {
    if (this.replacement === native || this.stream !== native || this.state === false)
        return;

    if (this.replacement) {
        this.swapNatives();
        return;
    }
    this.stickies.close = [ this ];
    delete this.stickies.open;
    this.emit ('close', this);
};

/**     @member/Function assimilateNative
    @private
    Assimilate a native [MediaStream](), update the [readyState](#readyState) and potentially emit
    an event to reflect a change of ready state.
@argument/MediaStream native
*/
MultimediaStream.prototype.assimilateNative = function (native) {
    var self = this;
    native.onaddtrack = function (event) { self.emit ('addTrack', event); };
    native.onremovetrack = function (event) { self.emit ('removeTrack', event); };
    native.onstarted = function (event) { self.startNative (native); };
    native.onended = function (event) { self.endNative (native); };
};

/**     @local/Function rejectNative
    @private
    Strip event listeners from a native MediaStream and call `stop` if available.
*/
function rejectNative (native) {
    delete native.onaddtrack;
    delete native.onremovetrack;
    delete native.onstarted;
    delete native.onended;
    if (native.stop)
        native.stop();
}

/**     @member/Function close
    @api
    Terminate the stream and remove it from any [Elements]() currently playing it. Native streams
    will be stopped. If the stream was previously [sent to a Peer](Peer#addStream) it will be
    removed from the link.
*/
MultimediaStream.prototype.close = function(){
    if (this.stream)
        rejectNative (this.stream);
    if (this.replacement)
        rejectNative (this.replacement);

    if (!this.url) {
        if (this.state !== false) {
            this.state = false;
            this.emit ('close');
        }
        return;
    }

    var elems = [];
    elems.push.apply (elems, window.document.getElementsByTagName ('video'));
    elems.push.apply (elems, window.document.getElementsByTagName ('audio'));
    if (!elems.length) {
        if (this.state !== false) {
            this.state = false;
            this.emit ('close');
        }
        return;
    }
    for (var i=0,j=elems.length; i<j; i++)
        if (elems[i].getAttribute ('src') == this.url) {
            elems[i].pause();
            elems[i].removeAttribute ('src');
        }
    delete this.url;
    if (this.state !== false) {
        this.state = false;
        this.emit ('close');
    }
};

/**     @member/Function addTrack
    @api
    Add a media track to this multimedia stream. If the track is already found, performs no action.
    Tracks must not have already reached the end of their content and emitted the `ended` event.
@throws/INVALID_STATE_RAISE `stream ended`
    A stream that has reached the end of its content and emitted the `ended` event cannot be added
    to a stream.
@argument/MediaStreamTrack track
*/
MultimediaStream.prototype.addTrack = function (track) { return this.stream.addTrack (track); };

/**     @member/Function clone
    @api
    Create a duplicate of this stream, pointing to the same resources (MediaStreamTrack instances)
    but holding a different [id](#id) property.
*/
MultimediaStream.prototype.clone = function(){ return new MultimediaStream (this.stream.clone()); };

/**     @member/Function getAudioTracks
    @api
    Retrieve all MediaStreamTrack instances in this stream that carry audio data.
*/
MultimediaStream.prototype.getAudioTracks = function(){ return this.stream.getAudioTracks(); };

/**     @member/Function getVideoTracks
    @api
    Retrieve all MediaStreamTrack instances in this stream that carry video data.
*/
MultimediaStream.prototype.getVideoTracks = function(){ return this.stream.getVideoTracks(); };

/**     @member/Function getTrackById
    @api
    Attempt to retrieve a MediaStreamTrack instance from this stream holding a given id. Because
    track ids are not unique, the first track of a given id is returned. If the track is not found,
    `null` is returned.
@argument/String id
@returns/MediaStreamTrack|null
*/
MultimediaStream.prototype.getTrackById = function (id) { return this.stream.getTrackById (id); };

/**     @member/Function removeTrack
    @api
    Remove a track from this multimedia stream by matching its exact reference.
@argument/MediaStreamTrack track
    If this track appears on the stream, remove it.
*/
MultimediaStream.prototype.removeTrack = function (track) { return this.stream.removeTrack (track); };

/**     @member/Function toURL
    @api
    Retrieve an Object URL for the given stream. Setting the `src` property of a `video` tag to this
    String will cause the underlying stream to begin consuming bytes from the remote peer and output
    content to the user.
@returns/String
    An Object URL for consuming the media stream.
*/
MultimediaStream.prototype.toURL = function(){
    return this.url || ( this.url = URL.createObjectURL (this.stream) );
};
