
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
    if (objType == 'function') {
        console.trace();
        return process.exit(1);
    }
    if (objType == 'undefined')
        return undefined;
    if (objType == 'number')
        return Number (target); // otherwise you get heap Numbers instead of natives... it's weird.
    if (objType == 'string')
        return String (target); // otherwise you get heap Strings instead of natives... it's weird.
    if (objType == 'boolean')
        return Boolean (target); // otherwise you get heap Strings instead of natives... it's weird.
    var newObj = objType == 'array' ? [] : {};
    for (var key in target)
        newObj[key] = clone (target[key]);
    return newObj;
}


/**     @property/Function merge
    Overwrite properties on an object with those of another object, recursing into Objects and
    Arrays.
@argument obj
*/
function merge (target, source) {
    for (var key in source) {
        if (!Object.hasOwnProperty.call (target, key)) {
            target[key] = source[key];
            continue;
        }
        var val = source[key];
        var type = getTypeStr (val);
        if (type != 'object' && type != 'array')
            target[key] = val;
        else if (type != getTypeStr (target[key])) {
            target[key] = source[key];
            continue;
        } else
            merge (target[key], source[key]);
    }
}


module.exports.getTypeStr = getTypeStr;
module.exports.clone = clone;
module.exports.merge = merge;
