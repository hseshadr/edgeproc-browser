/** One exact cosine result from an immutable packed matrix. */
export interface PackedVectorHit {
    readonly id: string;
    readonly similarity: number;
}
/**
 * Dependency-free synchronous cosine index for signed, immutable matrices.
 *
 * The constructor copies its inputs so a caller cannot mutate authenticated
 * bundle bytes after validation. Ties retain the producer's row order.
 */
export declare class PackedVectorIndex {
    #private;
    readonly dim: number;
    readonly ntotal: number;
    constructor(matrix: Float32Array, ids: ReadonlyArray<string>, dimension: number);
    search(query: Float32Array, limit: number): ReadonlyArray<PackedVectorHit>;
    similarityOf(id: string, query: Float32Array): number;
    idAt(row: number): string;
    /** Return one producer row as a defensive copy. */
    vectorAt(row: number): Float32Array;
    dispose(): void;
}
//# sourceMappingURL=packed.d.ts.map