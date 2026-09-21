/** Values that may cross the vector metadata/filter boundary. */
export type Scalar = string | number | boolean | null;
/** Flat, equality-filterable metadata. Nested objects are deliberately excluded. */
export type Metadata = Readonly<Record<string, Scalar>>;
/** A vector and the application-owned metadata stored beside it. */
export interface VectorRecord {
    readonly id: string;
    readonly vector: Float32Array;
    readonly metadata: Metadata;
}
/** A nearest-neighbour hit. Lower distance always means a closer match. */
export interface VectorHit {
    readonly id: string;
    readonly distance: number;
    readonly metadata: Metadata;
}
/** Observable index size for either the full index or a metadata scope. */
export interface VectorStats {
    readonly name: string;
    readonly dimension: number;
    readonly vectorCount: number;
    /** Bytes occupied by float32 vector values, excluding adapter overhead. */
    readonly vectorBytes: number;
}
export type VectorDistanceMetric = "cosine";
/** Features callers may negotiate without depending on a concrete adapter. */
export interface VectorIndexCapabilities {
    readonly metrics: ReadonlyArray<VectorDistanceMetric>;
    readonly exact: boolean;
    readonly persistent: boolean;
    readonly metadataFiltering: boolean;
    readonly scopedDelete: boolean;
}
export interface VectorIndexOptions {
    readonly name: string;
    readonly dimension: number;
}
/**
 * Replaceable browser semantic-similarity index.
 *
 * Filters are equality predicates ANDed across every key. Missing or empty
 * filters are unscoped. Implementations must reject wrong-dimension and
 * non-finite vectors instead of returning partial or corrupted results.
 */
export interface VectorIndex {
    readonly name: string;
    readonly dimension: number;
    readonly capabilities: VectorIndexCapabilities;
    /** Insert or replace records by id. */
    insert(records: ReadonlyArray<VectorRecord>): Promise<void>;
    /** Read one record by id. Returned data must be safe for the caller to mutate. */
    read(id: string): Promise<VectorRecord | undefined>;
    /** Exact or approximate nearest neighbours, ordered by ascending distance. */
    search(query: Float32Array, limit: number, filters?: Metadata): Promise<ReadonlyArray<VectorHit>>;
    /** Delete only named records that match the optional scope; return the count. */
    delete(ids: ReadonlyArray<string>, filters?: Metadata): Promise<number>;
    /** Delete every record matching a non-empty metadata scope; return the count. */
    deleteWhere(filters: Metadata): Promise<number>;
    /** Atomically delete every record in this index; return the count. */
    clear(): Promise<number>;
    /** Report live vectors in the optional scope. */
    stats(filters?: Metadata): Promise<VectorStats>;
    /** Release adapter resources. Further use must fail closed. */
    dispose(): Promise<void>;
}
/** Factory seam shared by memory, SQLite/OPFS, and future remote adapters. */
export type VectorIndexFactory = (options: VectorIndexOptions) => VectorIndex | Promise<VectorIndex>;
//# sourceMappingURL=types.d.ts.map