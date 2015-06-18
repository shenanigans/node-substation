
/**     @module substation.Common
    @development
    Simple utility methods.
*/


/**     @property/Function getTypeStr
    Gets a proper type name for a reference, in all lowercase.
@argument obj
*/
var typeGetter = ({}).toString;
function getTypeStr (obj) {
    var tstr = typeGetter.apply(obj).slice(8,-1).toLowerCase();
    if (tstr == 'object' && obj instanceof Buffer) return 'buffer';
    return tstr;
}


/**     @property/Function clone
    Create a JSON-identical duplicate of a reference with no refs in common.
@argument obj
*/
function clone (target) {
    var objType = getTypeStr (target);
    switch (objType) {
        case 'function':
            throw new Error ('cannot clone Functions');
        case 'undefined':
            return undefined;
        case 'number':
            return Number (target); // otherwise you get heap Numbers instead of natives... it's weird.
        case 'string':
            return String (target); // otherwise you get heap Strings instead of natives... it's weird.
        case 'boolean':
            return Boolean (target); // otherwise you get heap Strings instead of natives... it's weird.
        case 'array':
            return target.slice().map(clone);
        case 'object':
            var newObj = {};
            var keys = Object.keys(target);
            for (var i=0,j=keys.length; i<j; i++)
                newObj[keys[i]] = clone (target[keys[i]]);
            return newObj;
        default:
            throw new Error ('cannot clone type "'+objType+'"');
    }
}


/**     @property/Function merge
    Overwrite properties on an object with those of another object, recursing into Objects and
    Arrays.
@argument obj
*/
function merge (target, source) {
    var keys = Object.keys (source);
    for (var i=0,j=keys.length; i<j; i++) {
        var key = keys[i];
        var val = source[key];
        if (!Object.hasOwnProperty.call (target, key)) {
            target[key] = val;
            continue;
        }
        var type = getTypeStr (val);
        if (type != getTypeStr (target[key])) {
            target[key] = val;
            continue;
        }
        if (type == 'object')
            merge (target[key], val);
        else if (type == 'array')
            mergeArray (target[key], val);
        else
            target[key] = val;
    }
}

function mergeArray (target, source) {
    for (var i=0,j=source.length; i<j; i++) {
        var val = source[i];
        if (i > target.length) {
            target[i] = val;
            continue;
        }
        var type = getTypeStr (val);
        if (type != getTypeStr (target[i])) {
            target[i] = val;
            continue;
        }
        if (type == 'object')
            merge (target[i], val);
        else if (type == 'array')
            mergeArray (target[i], val);
        else
            target[i] = val;
    }
}


module.exports.getTypeStr = getTypeStr;
module.exports.clone = clone;
module.exports.merge = merge;
