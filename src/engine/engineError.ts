import { SignatureError } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import { StorageQuotaError } from "./storageError.js";
import { RollbackError } from "./sync.js";

export type EngineErrorCode =
	| "integrity"
	| "rollback"
	| "network"
	| "lock"
	| "storage"
	| "internal";

export interface EngineErrorDetail {
	readonly code: EngineErrorCode;
	readonly message: string;
}

/** A stable main-thread error that preserves the Worker's failure category. */
export class EngineOperationError extends Error {
	public readonly code: EngineErrorCode;

	public constructor(detail: EngineErrorDetail) {
		super(detail.message);
		this.name = "EngineOperationError";
		this.code = detail.code;
	}
}

export function classifyEngineError(error: unknown): EngineErrorDetail {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof RollbackError) return { code: "rollback", message };
	if (error instanceof SignatureError || error instanceof IntegrityError) {
		return { code: "integrity", message };
	}
	if (error instanceof NetworkError) return { code: "network", message };
	if (/timed out acquiring (?:an? )?opfs mutation lock/iu.test(message)) {
		return { code: "lock", message };
	}
	if (
		error instanceof StorageQuotaError ||
		/storage|indexeddb|opfs|quota/iu.test(message)
	) {
		return { code: "storage", message };
	}
	return { code: "internal", message };
}
