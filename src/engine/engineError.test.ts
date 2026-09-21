import { describe, expect, it } from "vitest";
import { SignatureError } from "./crypto.js";
import { classifyEngineError, EngineOperationError } from "./engineError.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import { StorageQuotaError } from "./storageError.js";
import { RollbackError } from "./sync.js";

describe("typed Worker error contract", () => {
	it.each([
		[new RollbackError("old"), "rollback"],
		[new SignatureError("bad signature"), "integrity"],
		[new IntegrityError("bad hash"), "integrity"],
		[new NetworkError("offline"), "network"],
		[new StorageQuotaError(), "storage"],
		[new Error("timed out acquiring OPFS mutation lock"), "lock"],
		[new Error("OPFS initialization failed"), "storage"],
		[new Error("surprise"), "internal"],
	] as const)("classifies %s", (error, code) => {
		expect(classifyEngineError(error)).toEqual({
			code,
			message: error.message,
		});
	});

	it("preserves a stable code on the main-thread error", () => {
		const error = new EngineOperationError({
			code: "network",
			message: "offline",
		});
		expect(error).toMatchObject({
			name: "EngineOperationError",
			code: "network",
			message: "offline",
		});
	});
});
