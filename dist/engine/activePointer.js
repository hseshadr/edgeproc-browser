const SHA256 = /^[0-9a-f]{64}$/u;
/** Parse untrusted durable state without granting it rollback authority. */
export function parseStoredPointer(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const pointer = value;
    if (typeof pointer.manifest_hash !== "string" ||
        !SHA256.test(pointer.manifest_hash) ||
        !boundedString(pointer.version, 200) ||
        !boundedString(pointer.signature, 512) ||
        !storedSequence(pointer.sequence) ||
        !optionalBoundedString(pointer.bundle_id, 200) ||
        !optionalBoundedString(pointer.channel, 200)) {
        return null;
    }
    return pointer;
}
function storedSequence(value) {
    return (value === undefined ||
        value === null ||
        (Number.isSafeInteger(value) && value >= 0));
}
export function samePointer(left, right) {
    return (left !== null &&
        left.manifest_hash === right.manifest_hash &&
        left.version === right.version &&
        left.sequence === right.sequence &&
        left.signature === right.signature &&
        (left.bundle_id ?? null) === (right.bundle_id ?? null) &&
        (left.channel ?? null) === (right.channel ?? null));
}
function boundedString(value, maximum) {
    return (typeof value === "string" && value.length > 0 && value.length <= maximum);
}
function optionalBoundedString(value, maximum) {
    return (value === undefined ||
        value === null ||
        (typeof value === "string" && value.length <= maximum));
}
//# sourceMappingURL=activePointer.js.map