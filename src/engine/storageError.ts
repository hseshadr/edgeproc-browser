/** A stable storage-boundary failure suitable for Worker error classification. */
export class StorageQuotaError extends Error {
	public constructor(
		message = "browser storage quota exhausted",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StorageQuotaError";
	}
}

export function isQuotaError(error: unknown): boolean {
	return (
		(error instanceof DOMException &&
			["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"].includes(
				error.name,
			)) ||
		(error instanceof Error &&
			(error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
				/quota(?:[ _-]?exceeded|[ _-]?reached)?/iu.test(error.message)))
	);
}

export function translateStorageError(error: unknown): Error {
	return isQuotaError(error)
		? new StorageQuotaError("browser storage quota exhausted", { cause: error })
		: error instanceof Error
			? error
			: new Error(String(error));
}
