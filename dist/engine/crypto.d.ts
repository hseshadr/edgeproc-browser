/** Raised when a signature is absent, malformed, or does not verify. */
export declare class SignatureError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
/** Bare lowercase hex sha256 of `bytes` via WebCrypto. */
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
/**
 * Fail-closed ed25519 verify against a pinned raw 32-byte public key.
 *
 * Uses WebCrypto `crypto.subtle.verify("Ed25519", ...)` where available and
 * falls back to `@noble/ed25519` otherwise. Resolves on a valid signature;
 * THROWS `SignatureError` on a bad/malformed signature or any verify error —
 * a forged pointer never escapes as a stray exception type.
 */
export declare function verifyEd25519(pubkeyRaw32: Uint8Array, message: Uint8Array, signatureBase64: string): Promise<void>;
//# sourceMappingURL=crypto.d.ts.map