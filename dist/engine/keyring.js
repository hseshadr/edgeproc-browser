// The trust root as a keyring: every key a publisher may sign with, plus the
// key ids it has revoked. Fail-closed by construction — a malformed trust root
// is refused whole, a revoked key never verifies, and a pointer that names its
// signer is checked under THAT key only.
//
// Wire forms of the configured trust-root URL (auto-detected):
//   * exactly 32 bytes  -> the legacy raw Ed25519 public key, a keyring of one;
//   * anything else     -> a strict JSON document:
//       {"schema":"edgeproc.keyring/v1",
//        "keys":[{"key_id":"<16 hex>","public_key":"<64 hex>"}],
//        "revoked":["<16 hex>", ...]}
// A key id is the first 16 lowercase hex chars of sha256(raw public key), the
// same derivation edge-proc (Python) uses.
import { SignatureError, sha256Hex, verifyEd25519 } from "./crypto.js";
import { IntegrityError } from "./integrity.js";
export const KEYRING_SCHEMA = "edgeproc.keyring/v1";
/** Upper bound on trust-root bytes, enforced before any decode or parse. */
export const MAX_TRUST_ROOT_BYTES = 64 * 1024;
const MAX_KEYS = 64;
const MAX_REVOKED = 1024;
const RAW_KEY_BYTES = 32;
const KEY_ID = /^[0-9a-f]{16}$/u;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/u;
const TOP_LEVEL = ["keys", "revoked", "schema"];
const KEY_FIELDS = ["key_id", "public_key"];
/** The trust root itself is malformed. Integrity-class: nothing verifies. */
export class KeyringError extends IntegrityError {
    constructor(message, options) {
        super(message, options);
        this.name = "KeyringError";
    }
}
/** The pointer names a signer the keyring has revoked. */
export class KeyRevokedError extends SignatureError {
    constructor(message = "pointer signer key is revoked") {
        super(message);
        this.name = "KeyRevokedError";
    }
}
/** The pointer names a signer the keyring does not contain. */
export class UnknownKeyError extends SignatureError {
    constructor(message = "pointer signer key is not in the keyring") {
        super(message);
        this.name = "UnknownKeyError";
    }
}
/** First 16 lowercase hex chars of sha256(raw 32-byte public key). */
export async function deriveKeyId(publicKey) {
    return (await sha256Hex(publicKey)).slice(0, 16);
}
function fromHex(text) {
    const out = new Uint8Array(text.length / 2);
    for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
}
function exactObject(value, fields, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new KeyringError(`${label} must be an object`);
    }
    const record = value;
    const keys = Object.keys(record).sort();
    if (keys.length !== fields.length ||
        keys.some((key, index) => key !== fields[index])) {
        throw new KeyringError(`${label} must have exactly: ${fields.join(", ")}`);
    }
    return record;
}
function boundedArray(value, maximum, label) {
    if (!Array.isArray(value)) {
        throw new KeyringError(`keyring ${label} must be an array`);
    }
    if (value.length > maximum) {
        throw new KeyringError(`keyring ${label} exceeds ${maximum} entries`);
    }
    return value;
}
function revokedIds(value) {
    const ids = boundedArray(value, MAX_REVOKED, "revoked");
    const seen = new Set();
    for (const id of ids) {
        if (typeof id !== "string" || !KEY_ID.test(id)) {
            throw new KeyringError("revoked key ids must be 16 lowercase hex chars");
        }
        if (seen.has(id))
            throw new KeyringError(`key ${id} is revoked twice`);
        seen.add(id);
    }
    return ids;
}
async function trustedKey(value) {
    const entry = exactObject(value, KEY_FIELDS, "keyring key");
    if (typeof entry.key_id !== "string" || !KEY_ID.test(entry.key_id)) {
        throw new KeyringError("keyring key_id must be 16 lowercase hex chars");
    }
    if (typeof entry.public_key !== "string" ||
        !PUBLIC_KEY_HEX.test(entry.public_key)) {
        throw new KeyringError("keyring public_key must be 64 lowercase hex chars");
    }
    return { keyId: entry.key_id, publicKey: fromHex(entry.public_key) };
}
function decodeDocument(bytes) {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch (cause) {
        throw new KeyringError("trust root is neither a 32-byte key nor a JSON keyring", { cause });
    }
}
/**
 * Revalidate a keyring: ids are derived from their keys, keys are 32 bytes,
 * nothing is listed twice, revoked ids are well formed, and at least one key
 * remains unrevoked. Throws {@link KeyringError}.
 */
export async function assertKeyring(keyring) {
    if (typeof keyring !== "object" ||
        keyring === null ||
        !Array.isArray(keyring.keys) ||
        !Array.isArray(keyring.revoked)) {
        throw new KeyringError("keyring must have keys and revoked lists");
    }
    const revoked = new Set(revokedIds(keyring.revoked));
    boundedArray(keyring.keys, MAX_KEYS, "keys");
    const seen = new Set();
    let usable = 0;
    for (const key of keyring.keys) {
        if (typeof key !== "object" ||
            key === null ||
            !(key.publicKey instanceof Uint8Array) ||
            key.publicKey.byteLength !== RAW_KEY_BYTES ||
            (await deriveKeyId(key.publicKey)) !== key.keyId) {
            throw new KeyringError("keyring key_id must be derived from a 32-byte public key");
        }
        if (seen.has(key.keyId)) {
            throw new KeyringError(`key ${key.keyId} is listed twice`);
        }
        seen.add(key.keyId);
        if (!revoked.has(key.keyId))
            usable += 1;
    }
    if (usable === 0) {
        throw new KeyringError("keyring has no unrevoked key");
    }
}
/**
 * Parse trust-root bytes: exactly 32 bytes is the legacy raw key (a keyring
 * of one, behavior unchanged); anything else must be a strict
 * `edgeproc.keyring/v1` JSON document. Throws {@link KeyringError}.
 */
export async function parseTrustRoot(bytes) {
    if (bytes.byteLength > MAX_TRUST_ROOT_BYTES) {
        throw new KeyringError(`trust root exceeds ${MAX_TRUST_ROOT_BYTES}-byte cap`);
    }
    let keyring;
    if (bytes.byteLength === RAW_KEY_BYTES) {
        const publicKey = new Uint8Array(bytes);
        keyring = {
            keys: [{ keyId: await deriveKeyId(publicKey), publicKey }],
            revoked: [],
        };
    }
    else {
        const document = exactObject(decodeDocument(bytes), TOP_LEVEL, "keyring document");
        if (document.schema !== KEYRING_SCHEMA) {
            throw new KeyringError(`keyring schema must be ${KEYRING_SCHEMA}`);
        }
        const entries = boundedArray(document.keys, MAX_KEYS, "keys");
        const keys = [];
        for (const entry of entries)
            keys.push(await trustedKey(entry));
        keyring = { keys, revoked: revokedIds(document.revoked) };
    }
    await assertKeyring(keyring);
    return Object.freeze({
        keys: Object.freeze(keyring.keys.map((key) => Object.freeze(key))),
        revoked: Object.freeze([...keyring.revoked]),
    });
}
/** Fetch and parse the trust root: no HTTP-cache reuse, bounded response. */
export async function loadTrustRoot(url, fetchBytes) {
    return parseTrustRoot(await fetchBytes(url, {
        cache: "no-store",
        maxBytes: MAX_TRUST_ROOT_BYTES,
    }));
}
/**
 * Fail-closed verify of `message` under a keyring.
 *
 * With `keyId`: revoked -> {@link KeyRevokedError}; not in the ring ->
 * {@link UnknownKeyError}; otherwise ONLY that key is tried. Without one: any
 * unrevoked key may verify, and a revoked key's signature never does.
 * Every refusal is a {@link SignatureError}.
 */
export async function verifyWithKeyring(keyring, message, signatureBase64, keyId) {
    const revoked = new Set(keyring.revoked);
    if (keyId !== undefined && keyId !== null) {
        if (revoked.has(keyId))
            throw new KeyRevokedError();
        const key = keyring.keys.find((candidate) => candidate.keyId === keyId);
        if (key === undefined)
            throw new UnknownKeyError();
        await verifyEd25519(key.publicKey, message, signatureBase64);
        return;
    }
    for (const key of keyring.keys) {
        if (revoked.has(key.keyId))
            continue;
        try {
            await verifyEd25519(key.publicKey, message, signatureBase64);
            return;
        }
        catch {
            // verifyEd25519 only ever throws SignatureError: try the next key.
        }
    }
    throw new SignatureError();
}
//# sourceMappingURL=keyring.js.map