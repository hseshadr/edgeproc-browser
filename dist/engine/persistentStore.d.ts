import { type IndexedDbLayoutOptions } from "./indexedDbStore.js";
import type { CacheBackend, CacheStore, StoragePreference } from "./types.js";
export type { CacheBackend, StoragePreference } from "./types.js";
export interface PersistentCacheStore extends CacheStore {
    readonly cacheBackend: CacheBackend;
}
export interface PersistentStoreOpeners {
    readonly openOpfs: () => Promise<CacheStore>;
    readonly openIndexedDb: () => Promise<PersistentCacheStore>;
}
export interface PersistentStoreOptions {
    readonly namespace?: string;
    readonly storageBackend?: StoragePreference;
    readonly indexedDbLayout?: IndexedDbLayoutOptions;
    readonly openers?: PersistentStoreOpeners;
}
export declare function requestPersistentStorage(storage: Pick<StorageManager, "persist"> | undefined): void;
export declare function openPersistentCacheStore(options?: PersistentStoreOptions): Promise<PersistentCacheStore>;
//# sourceMappingURL=persistentStore.d.ts.map