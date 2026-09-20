// Shared fail-closed content-address rule: a chunk's name is sha256(plaintext).
// Both CacheStore implementations route ingest + read through these so the
// integrity boundary is identical (mirrors edge-proc cas.py _verify_or_remove).
import { sha256Hex } from "./crypto.js";
import { decompressBounded } from "./zstd.js";
export const MAX_DECOMPRESSED_CHUNK_BYTES = 8 * 1024 * 1024;
/** A stored object failed its content-address / decompress check (fail-closed). */
export class IntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "IntegrityError";
    }
}
/** Decompress + verify sha256(plaintext) == chunkHash, else throw. Returns plaintext. */
export async function decompressAndVerify(chunkHash, compressed, expectedSize) {
    if (!Number.isSafeInteger(expectedSize) ||
        expectedSize < 0 ||
        expectedSize > MAX_DECOMPRESSED_CHUNK_BYTES) {
        throw new IntegrityError(`chunk ${chunkHash} declares invalid decompressed size ${expectedSize}`);
    }
    let plaintext;
    try {
        plaintext = await decompressBounded(compressed, expectedSize);
    }
    catch (cause) {
        throw new IntegrityError(`chunk ${chunkHash} failed to decompress`, {
            cause,
        });
    }
    if (plaintext.byteLength !== expectedSize) {
        throw new IntegrityError(`chunk ${chunkHash} decompressed to ${plaintext.byteLength} bytes, expected ${expectedSize}`);
    }
    if ((await sha256Hex(plaintext)) !== chunkHash) {
        throw new IntegrityError(`chunk ${chunkHash} failed content-address check`);
    }
    return plaintext;
}
/** Verify plaintext sha256 matches the chunk name, else throw. */
export async function verifyPlaintext(chunkHash, plaintext) {
    if ((await sha256Hex(plaintext)) !== chunkHash) {
        throw new IntegrityError(`chunk ${chunkHash} failed content-address check`);
    }
}
//# sourceMappingURL=integrity.js.map