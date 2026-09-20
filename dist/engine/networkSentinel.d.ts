/** The same-origin channel every context publishes and reads sentinel reports on. */
export declare const NETWORK_SENTINEL_CHANNEL = "edgeproc:network-sentinel";
/** Discriminator for a sentinel report; the channel carries nothing else. */
export declare const NETWORK_SENTINEL_REPORT_KIND = "network-sentinel-report";
/** One observed network request, timestamped on the shared epoch clock. */
export interface SentinelEntry {
    readonly name: string;
    /** `performance.timeOrigin + entry.startTime` — comparable across contexts. */
    readonly startedAtEpochMs: number;
}
/** A context's full view of its own network activity so far. */
export interface NetworkSentinelReport {
    readonly kind: typeof NETWORK_SENTINEL_REPORT_KIND;
    /** Which context reported, so a reader can replace rather than accumulate. */
    readonly context: string;
    readonly entries: readonly SentinelEntry[];
}
/**
 * Narrow the raw `PerformanceEntry[]` a browser hands the observer to the
 * epoch-stamped slice a report carries. Same DEGRADE-and-skip contract as the
 * window-side guard: an entry missing either read field, or of the wrong type,
 * is dropped — throwing here would escape the observer callback.
 */
export declare function toSentinelEntries(raw: readonly unknown[], timeOrigin: number): readonly SentinelEntry[];
/**
 * Runtime guard for a message arriving off the channel. Same-origin is not the
 * same as trusted — any script in the origin can post here — so a report is
 * only counted once its shape is proven.
 */
export declare function isNetworkSentinelReport(value: unknown): value is NetworkSentinelReport;
/**
 * Start reporting this context's network activity. Call once, at the top of a
 * Worker entry module. Returns a cleanup function; no-ops where unsupported.
 *
 * Each flush re-reads and broadcasts the FULL buffered list rather than a
 * delta, so a reader that subscribes late still receives everything on the next
 * flush and can replace this context's slice wholesale.
 */
export declare function installNetworkSentinel(context: string): () => void;
//# sourceMappingURL=networkSentinel.d.ts.map