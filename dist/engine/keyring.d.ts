import { SignatureError } from "./crypto.js";
import { IntegrityError } from "./integrity.js";
import type { FetchBytes } from "./types.js";
export declare const KEYRING_SCHEMA = "edgeproc.keyring/v1";
/** Upper bound on trust-root bytes, enforced before any decode or parse. */
export declare const MAX_TRUST_ROOT_BYTES: number;
/** One trusted Ed25519 key and its derived id. */
export interface TrustedKey {
    readonly keyId: string;
    /** Raw 32-byte Ed25519 public key. */
    readonly publicKey: Uint8Array;
}
/** A parsed trust root. Build it with {@link parseTrustRoot}; a hand-built
 * value is revalidated by {@link assertKeyring} before sync trusts it. */
export interface Keyring {
    readonly keys: ReadonlyArray<TrustedKey>;
    /** Key ids that must never verify, whether or not `keys` still lists them. */
    readonly revoked: ReadonlyArray<string>;
}
/** The trust root itself is malformed. Integrity-class: nothing verifies. */
export declare class KeyringError extends IntegrityError {
    constructor(message: string, options?: ErrorOptions);
}
/** The pointer names a signer the keyring has revoked. */
export declare class KeyRevokedError extends SignatureError {
    constructor(message?: string);
}
/** The pointer names a signer the keyring does not contain. */
export declare class UnknownKeyError extends SignatureError {
    constructor(message?: string);
}
/** First 16 lowercase hex chars of sha256(raw 32-byte public key). */
export declare function deriveKeyId(publicKey: Uint8Array): Promise<string>;
/**
 * Revalidate a keyring: ids are derived from their keys, keys are 32 bytes,
 * nothing is listed twice, revoked ids are well formed, and at least one key
 * remains unrevoked. Throws {@link KeyringError}.
 */
export declare function assertKeyring(keyring: Keyring): Promise<void>;
/**
 * Parse trust-root bytes: exactly 32 bytes is the legacy raw key (a keyring
 * of one, behavior unchanged); anything else must be a strict
 * `edgeproc.keyring/v1` JSON document. Throws {@link KeyringError}.
 */
export declare function parseTrustRoot(bytes: Uint8Array): Promise<Keyring>;
/** Fetch and parse the trust root: no HTTP-cache reuse, bounded response. */
export declare function loadTrustRoot(url: string, fetchBytes: FetchBytes): Promise<Keyring>;
/**
 * Fail-closed verify of `message` under a keyring.
 *
 * With `keyId`: revoked -> {@link KeyRevokedError}; not in the ring ->
 * {@link UnknownKeyError}; otherwise ONLY that key is tried. Without one: any
 * unrevoked key may verify, and a revoked key's signature never does.
 * Every refusal is a {@link SignatureError}.
 */
export declare function verifyWithKeyring(keyring: Keyring, message: Uint8Array, signatureBase64: string, keyId?: string | null): Promise<void>;
//# sourceMappingURL=keyring.d.ts.map