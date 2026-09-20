const DEFAULT_CACHE_NAMESPACE = "edgeproc-browser";

export interface CacheLockManager {
	request<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

/** Serialize sync/read/prune operations that share one durable namespace. */
export function runWithCacheLock<T>(
	locks: CacheLockManager | undefined,
	operation: () => Promise<T>,
	namespace = DEFAULT_CACHE_NAMESPACE,
): Promise<T> {
	return locks === undefined
		? operation()
		: locks.request(`${validatedNamespace(namespace)}-sync`, operation);
}

export function cacheDatabaseName(namespace = DEFAULT_CACHE_NAMESPACE): string {
	return `${validatedNamespace(namespace)}-cache`;
}

export function validatedNamespace(namespace: string): string {
	if (!/^[a-z][a-z0-9-]{0,62}$/u.test(namespace)) {
		throw new TypeError(
			"cache namespace must start with a letter and contain only lowercase letters, digits, or hyphens",
		);
	}
	return namespace;
}
