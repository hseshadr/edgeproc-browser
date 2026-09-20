const DEFAULT_CACHE_NAMESPACE = "edgeproc-browser";
/** Serialize sync/read/prune operations that share one durable namespace. */
export function runWithCacheLock(locks, operation, namespace = DEFAULT_CACHE_NAMESPACE) {
    return locks === undefined
        ? operation()
        : locks.request(`${validatedNamespace(namespace)}-sync`, operation);
}
export function cacheDatabaseName(namespace = DEFAULT_CACHE_NAMESPACE) {
    return `${validatedNamespace(namespace)}-cache`;
}
export function validatedNamespace(namespace) {
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(namespace)) {
        throw new TypeError("cache namespace must start with a letter and contain only lowercase letters, digits, or hyphens");
    }
    return namespace;
}
//# sourceMappingURL=cacheLock.js.map