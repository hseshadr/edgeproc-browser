/** The Worker fired 'error'/'messageerror': every in-flight request rejects. */
export declare class WorkerCrashError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** A request outlived its response deadline (backstop for silent hangs). */
export declare class WorkerTimeoutError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** Default per-request response deadline for the engine sync client. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/**
 * Default deadline for the embedder client. Deliberately larger: the FIRST
 * embed request also downloads + compiles the ~25 MB model, which on a slow
 * link legitimately takes minutes — a tight deadline would reject real users.
 */
export declare const DEFAULT_EMBED_TIMEOUT_MS = 300000;
//# sourceMappingURL=workerFault.d.ts.map