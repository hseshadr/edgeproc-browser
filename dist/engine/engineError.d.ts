export type EngineErrorCode = "integrity" | "rollback" | "network" | "lock" | "storage" | "internal";
export interface EngineErrorDetail {
    readonly code: EngineErrorCode;
    readonly message: string;
}
/** A stable main-thread error that preserves the Worker's failure category. */
export declare class EngineOperationError extends Error {
    readonly code: EngineErrorCode;
    constructor(detail: EngineErrorDetail);
}
export declare function classifyEngineError(error: unknown): EngineErrorDetail;
//# sourceMappingURL=engineError.d.ts.map