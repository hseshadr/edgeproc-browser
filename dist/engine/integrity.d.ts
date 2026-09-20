export declare const MAX_DECOMPRESSED_CHUNK_BYTES: number;
/** A stored object failed its content-address / decompress check (fail-closed). */
export declare class IntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** Decompress + verify sha256(plaintext) == chunkHash, else throw. Returns plaintext. */
export declare function decompressAndVerify(chunkHash: string, compressed: Uint8Array, expectedSize: number): Promise<Uint8Array>;
/** Verify plaintext sha256 matches the chunk name, else throw. */
export declare function verifyPlaintext(chunkHash: string, plaintext: Uint8Array): Promise<void>;
//# sourceMappingURL=integrity.d.ts.map