export interface CacheLockManager {
    request<T>(name: string, operation: () => Promise<T>): Promise<T>;
}
/** Serialize sync/read/prune operations that share one durable namespace. */
export declare function runWithCacheLock<T>(locks: CacheLockManager | undefined, operation: () => Promise<T>, namespace?: string): Promise<T>;
export declare function cacheDatabaseName(namespace?: string): string;
export declare function validatedNamespace(namespace: string): string;
//# sourceMappingURL=cacheLock.d.ts.map