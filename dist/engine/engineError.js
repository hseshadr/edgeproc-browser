import { SignatureError } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import { StorageQuotaError } from "./storageError.js";
import { RollbackError } from "./sync.js";
/** A stable main-thread error that preserves the Worker's failure category. */
export class EngineOperationError extends Error {
    code;
    constructor(detail) {
        super(detail.message);
        this.name = "EngineOperationError";
        this.code = detail.code;
    }
}
export function classifyEngineError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RollbackError)
        return { code: "rollback", message };
    if (error instanceof SignatureError || error instanceof IntegrityError) {
        return { code: "integrity", message };
    }
    if (error instanceof NetworkError)
        return { code: "network", message };
    if (error instanceof StorageQuotaError ||
        /storage|indexeddb|opfs|quota/iu.test(message)) {
        return { code: "storage", message };
    }
    return { code: "internal", message };
}
//# sourceMappingURL=engineError.js.map