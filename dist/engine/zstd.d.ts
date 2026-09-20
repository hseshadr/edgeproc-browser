/**
 * The decompressed size that `bytes` bindingly declares, or `null` when no bound
 * can be established before decoding — because the bytes are not a zstd frame,
 * the frame omits its Frame_Content_Size, or the input is not exactly one frame
 * (trailing bytes or a second concatenated frame would decode unbounded).
 *
 * Exported for tests: every chunk the Python producer writes is one declaring
 * frame whose declaration is the size its signed manifest entry claims.
 */
export declare function declaredContentSize(bytes: Uint8Array): number | null;
/**
 * Decompress a single frame that must declare — and produce — exactly
 * `expectedSize`.
 *
 * The bound is applied BEFORE the decoder runs: {@link declaredContentSize}
 * refuses anything that is not exactly one frame spanning every input byte and
 * bindingly declaring its size, and a declaration that differs from the signed
 * size is rejected. So neither a tiny frame claiming gigabytes nor a pack of
 * in-limit frames whose sum is gigabytes ever reaches WASM. The streaming
 * decoder then honours that declaration, `decompressEnd()` rejects a truncated
 * frame, and the length check below is the final fail-closed gate.
 *
 * Deliberately NOT `Zstd.decompress()`: that path allocates the frame's own
 * declared content size up front, which is exactly the attacker-controlled
 * number we refuse to trust.
 *
 * The three streaming calls run with no `await` between them, so they cannot
 * interleave with another caller on the library's process-wide singleton.
 */
export declare function decompressBounded(bytes: Uint8Array, expectedSize: number): Promise<Uint8Array>;
/** Test/diagnostic convenience for trusted local bytes. Runtime bundle reads use
 * {@link decompressBounded} with the signed manifest's validated chunk size. */
export declare function decompress(bytes: Uint8Array): Promise<Uint8Array>;
//# sourceMappingURL=zstd.d.ts.map