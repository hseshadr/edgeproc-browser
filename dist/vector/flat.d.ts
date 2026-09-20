import type { Metadata, VectorHit, VectorIndex, VectorIndexCapabilities, VectorIndexOptions, VectorRecord, VectorStats } from "./types.js";
/** Dependency-free, exact cosine-distance index for bounded browser datasets. */
export declare class FlatVectorIndex implements VectorIndex {
    #private;
    readonly name: string;
    readonly dimension: number;
    readonly capabilities: VectorIndexCapabilities;
    constructor(options: VectorIndexOptions);
    insert(records: ReadonlyArray<VectorRecord>): Promise<void>;
    read(id: string): Promise<VectorRecord | undefined>;
    search(query: Float32Array, limit: number, filters?: Metadata): Promise<ReadonlyArray<VectorHit>>;
    delete(ids: ReadonlyArray<string>, filters?: Metadata): Promise<number>;
    stats(filters?: Metadata): Promise<VectorStats>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=flat.d.ts.map