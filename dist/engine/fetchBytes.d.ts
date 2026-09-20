import { IntegrityError } from "./integrity.js";
import type { FetchBytes } from "./types.js";
export declare class NetworkError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** A response crossed its caller-owned byte ceiling. Integrity-class, not a
 * recoverable network outage: sync must never silently serve cache for it. */
export declare class ResponseTooLargeError extends IntegrityError {
    constructor(message: string);
}
export declare const FETCH_TIMEOUT_MS = 15000;
export declare const DEFAULT_MAX_FETCH_BYTES: number;
export declare const fetchBytes: FetchBytes;
//# sourceMappingURL=fetchBytes.d.ts.map