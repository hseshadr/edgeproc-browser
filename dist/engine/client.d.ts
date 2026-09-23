import type { IndexedDbLayoutOptions } from "./indexedDbStore.js";
import type { EngineRequest, EngineResponse } from "./protocol.js";
import type { SyncProgress } from "./sync.js";
import type { EngineSyncResult, StoragePreference } from "./types.js";
/** The minimal Worker surface this client needs — small so tests can fake it. */
export interface EngineWorkerLike {
    postMessage(message: EngineRequest): void;
    addEventListener(type: "message", listener: (event: MessageEvent<EngineResponse>) => void): void;
    addEventListener(type: "error", listener: (event: {
        message: string;
    }) => void): void;
    addEventListener(type: "messageerror", listener: () => void): void;
    terminate(): void;
}
/** Tuning knobs for the client (defaults suit the engine's sync/readFile calls). */
export interface EngineClientOptions {
    /** Idle deadline. Every authenticated sync progress event re-arms it. */
    readonly idleTimeoutMs?: number;
    /** @deprecated Use idleTimeoutMs. Retained for source compatibility. */
    readonly requestTimeoutMs?: number;
}
export interface EngineSyncOptions {
    /** undefined skips the identity check; null requires absent/null. */
    readonly expectedBundleId?: string | null;
    /** undefined skips the identity check; null requires absent/null. */
    readonly expectedChannel?: string | null;
    /** undefined fetches all files; [] authenticates/promotes only the catalog. */
    readonly wantedPaths?: ReadonlyArray<string>;
    readonly storageBackend?: StoragePreference;
    readonly cacheNamespace?: string;
    /** Existing consumers can declaratively retain their database/store/key layout. */
    readonly indexedDbLayout?: IndexedDbLayoutOptions;
    readonly onProgress?: (progress: SyncProgress) => void;
}
export type EngineStorageOptions = Pick<EngineSyncOptions, "storageBackend" | "cacheNamespace" | "indexedDbLayout">;
export declare class EngineClient {
    #private;
    constructor(worker: EngineWorkerLike, options?: EngineClientOptions);
    /** Sync the signed bundle at `baseUrl`, pinning the trust root at
     * `pubkeyUrl`: a raw 32-byte Ed25519 key, or an `edgeproc.keyring/v1` JSON
     * keyring (key rotation + revocation). */
    sync(baseUrl: string, pubkeyUrl: string, options?: EngineSyncOptions): Promise<EngineSyncResult>;
    sync(baseUrl: string, pubkeyUrl: string, expectedBundleId?: string | null, expectedChannel?: string | null, options?: Omit<EngineSyncOptions, "expectedBundleId" | "expectedChannel">): Promise<EngineSyncResult>;
    /** Materialize a synced file's bytes from the active manifest. */
    readFile(path: string): Promise<Uint8Array>;
    /** Clear this Worker's durable cache under the same lock used by sync/read. */
    clear(options?: EngineStorageOptions): Promise<void>;
    /** Reject in-flight work and release the sync worker. Safe to call twice. */
    dispose(): void;
    /** Backwards-compatible alias for callers that own the raw worker lifecycle. */
    terminate(): void;
}
//# sourceMappingURL=client.d.ts.map