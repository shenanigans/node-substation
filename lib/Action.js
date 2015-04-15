
var Common = require ('./Common');

/**     @class substation.Action
    @root
    Wraps a reaction function with its html templates and minimum authentication requirements.
@argument/.Configuration config
    @optional
    Specify templates and minimum authentication requirements, if desired.
@callback/Function reaction
    The reaction function, i.e. the working business logic being served by `substation` at a given
    url matching expression and request method.

    @argument/Array|Object params
        Selecting groups in the url, filled by the request url provided by the user.
    @argument/substation.AuthenticationStatus auth
    @argument/Reply reply
*/
function Action (config, reaction) {
    this.config = Common.clone (DEFAULT_CONFIG);
    Common.merge (this.config, config);
    this.reaction = reaction;
}


/**     @class Request
@url.URL url
@member/String method
@member/String format
@member/Object query
@member/Array params
@member/Object|undefined body
@member/Array|undefined files
@member/stream.Readable|undefined stream
@member/String|undefined contentType
*/


/**     @member/Function run

*/
Action.prototype.run = function (station, auth, request, reply) {
    if (this.config.bodySchema) {
        console.log ('check schema', request.body);
        var done = false;
        var reaction = this.reaction;
        try {
            var result = this.config.bodySchema (request.body, function (err) {
                if (done) return;
                if (err) {
                    reply.content ({ SchemaError:err });
                    return reply.done (406);
                }

                try {
                    reaction (station, auth, request, reply);
                } catch (err) {
                    reply.content ({ ActionError:err });
                    reply.done (403);
                }
            });
            if (result === undefined)
                return;
            done = true;
            if (!result)
                return reply.done (406);
        } catch (err) {
            reply.content ({ SchemaError:err });
            return reply.done (406);
        }
    }

    try {
        this.reaction (station, auth, request, reply);
    } catch (err) {
        reply.content ({ ActionError:err });
        reply.done (403);
    }
};


/**     @struct Configuration
@member/JSON authentication
    Specify a minimum authentication profile to access this Action. Unauthenticated requests are
    automatically served a blank 403 response.

    @property authentication.loggedIn
    @property authentication.domestic
@member/Function|Object template
    When a client uses this Action over the REST transport, a template will be executed if it is
    supplied. Specify either a single template Function or a map of response codes to template
    Functions. Wildcards may be used i.e. "2xx" or "30x". Most specific response code wins.

    @argument/Object template(context
        The template's execution context, i.e. the document to render to html.
    @callback template(callback
        @optional
        If the template does not return a String, `substation` will wait for this callback.
        @argument/Error|undefined err
        @argument/String html
            Rendered html output.
        @returns
    @returns/String|undefined template)html
        Synchronous templates may return their rendered content immediately and ignore the callback.
@member/Boolean binaryStreams
    If true, accept unknown content types and pass them, as well as `multipart/form-data` requests,
    to the Action as streams. The passed `request.body` will be a `ReadableStream` instance.
@member/Number bufferFiles
    @default "64000"
    Prebuffer trivial files into memory, up to the given number of bytes across all uploaded files.
    Handy for handling small file uploads (such as user avatars) in an application where file
    uploads are not a major feature.
*/
var DEFAULT_CONFIG = {
    binaryStreams:  false,
    maxBodyLength:  4096
};


/**     @member/Function ready
    Perform any asynchronous setup tasks necessary to prepare this Action to react to requests. Runs
    any configured [setup](.Configuration#setup) function.
@callback
*/
Action.prototype.ready = function (callback) {
    if (this.config.template)
        if (typeof this.config.template == 'function')
            this.template = { 200:this.config.template };
        else
            this.template = this.config.template;

    if (this.config.setup)
        return this.config.setup (this.config, function (err) {
            process.nextTick (function(){ callback (err); });
        });
    return process.nextTick (callback);
};


module.exports = Action;
