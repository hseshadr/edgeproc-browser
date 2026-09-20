import type { CacheStore, VersionPointer } from "./types.js";
export interface IndexedDbLayout {
    readonly database: string;
    readonly store: string;
    readonly separator: ":" | "/";
}
export type IndexedDbLayoutOptions = Partial<IndexedDbLayout>;
export declare function resolveIndexedDbLayout(options?: IndexedDbLayoutOptions, defaultDatabase?: string): IndexedDbLayout;
export declare class IndexedDbCacheStore implements CacheStore {
    #private;
    readonly cacheBackend: "indexeddb";
    private constructor();
    static open(options?: IndexedDbLayoutOptions | string): Promise<IndexedDbCacheStore>;
    hasChunk(chunkHash: string): Promise<boolean>;
    putChunkCompressed(chunkHash: string, compressed: Uint8Array, expectedSize: number): Promise<void>;
    getChunk(chunkHash: string, expectedSize: number): Promise<Uint8Array>;
    putManifest(bytes: Uint8Array): Promise<string>;
    getManifest(hash: string): Promise<Uint8Array>;
    readActive(): Promise<VersionPointer | null>;
    promote(pointer: VersionPointer): Promise<void>;
    clearActiveIf(expected: VersionPointer): Promise<boolean>;
    pruneInactive(): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=indexedDbStore.d.ts.map