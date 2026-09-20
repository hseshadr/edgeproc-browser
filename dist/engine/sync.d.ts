import { IntegrityError } from "./integrity.js";
import type { CacheStore, FetchBytes, IndexManifest, SyncResult, Verify } from "./types.js";
export type SyncProgress = {
    readonly phase: "pointer";
    readonly version: string;
} | {
    readonly phase: "manifest";
    readonly totalFiles: number;
    readonly selectedFiles: number;
} | {
    readonly phase: "chunks";
    readonly fetchedChunks: number;
    readonly totalChunks: number;
    readonly bytesFetched: number;
} | {
    readonly phase: "promoted";
    readonly result: SyncResult;
};
export interface SyncArgs {
    readonly baseUrl: string;
    readonly store: CacheStore;
    readonly fetchBytes: FetchBytes;
    readonly verify: Verify;
    /** undefined skips the check; null requires a legacy absent/null identity. */
    readonly expectedBundleId?: string | null;
    /** undefined skips the check; null requires a legacy absent/null channel. */
    readonly expectedChannel?: string | null;
    /** undefined fetches all file chunks; [] authenticates/promotes the catalog only. */
    readonly wantedPaths?: ReadonlyArray<string>;
    /** Observer only: exceptions are isolated from the integrity state machine. */
    readonly onProgress?: (progress: SyncProgress) => void;
    /** Test seam for bounded per-chunk network retry backoff. */
    readonly sleep?: (milliseconds: number) => Promise<void>;
    /** Tests/operators may only LOWER the aggregate cap, never raise the release
     * ceiling. This keeps failure paths cheap to exercise without weakening prod. */
    readonly limits?: {
        readonly maxTotalFetchBytes?: number;
    };
}
/** Maximum silent backoff before one chunk fetch is declared unreachable. */
export declare const MAX_CHUNK_RETRY_BUDGET_MS: number;
export declare class SyncCapError extends IntegrityError {
    constructor(message: string);
}
export declare class RollbackError extends IntegrityError {
    constructor(message: string);
}
export declare function syncIndex(args: SyncArgs): Promise<SyncResult>;
export declare function materializeFile(store: CacheStore, manifest: IndexManifest, path: string): Promise<Uint8Array>;
//# sourceMappingURL=sync.d.ts.map