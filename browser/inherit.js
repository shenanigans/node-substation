
function inherit (child, parent) {
    var dummy = function(){};
    dummy.prototype = parent.prototype;
    dummy = new dummy();
    var keys = Object.keys (child.prototype);
    for (var i=0,j=keys.length; i<j; i++) {
        var key = keys[i];
        dummy[key] = child.prototype[key];
    }
    child.prototype = dummy;
}

module.exports = inherit;
