// Deterministic JSON byte-encoding that BYTE-MATCHES Python's
// edgeproc.bundles.manifest.canonical_bytes:
//
//   json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
//   .encode("utf-8")
//
// i.e. dict keys sorted recursively, list order preserved, separators ","/":"
// with NO whitespace, non-ASCII emitted raw (UTF-8, not \uXXXX). The pointer
// signature is over these exact bytes — a mismatch means it will not verify.
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Serialize a value with recursively sorted object keys and no whitespace.
 *
 * `JSON.stringify` already uses `,`/`:` separators and emits non-ASCII raw
 * (matching `ensure_ascii=False`); supplying our own key ordering is the only
 * thing it lacks. We sort with the default `<` on UTF-16 code units, which
 * matches Python's `sorted()` on the ASCII keys used by the manifest schema.
 */
function serialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(serialize).join(",")}]`;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        const members = keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`);
        return `{${members.join(",")}}`;
    }
    return JSON.stringify(value);
}
/** Canonical UTF-8 bytes of `obj`, dropping any top-level `exclude` keys. */
export function canonicalBytes(obj, options = {}) {
    let payload = obj;
    const exclude = options.exclude;
    if (exclude !== undefined && isPlainObject(obj)) {
        const filtered = {};
        for (const key of Object.keys(obj)) {
            if (exclude[key] !== true) {
                filtered[key] = obj[key];
            }
        }
        payload = filtered;
    }
    return new TextEncoder().encode(serialize(payload));
}
//# sourceMappingURL=canonical.js.map