/** A stable storage-boundary failure suitable for Worker error classification. */
export declare class StorageQuotaError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
export declare function isQuotaError(error: unknown): boolean;
export declare function translateStorageError(error: unknown): Error;
//# sourceMappingURL=storageError.d.ts.map