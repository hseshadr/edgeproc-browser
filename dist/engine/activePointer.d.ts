import type { VersionPointer } from "./types.js";
/** Parse untrusted durable state without granting it rollback authority. */
export declare function parseStoredPointer(value: unknown): VersionPointer | null;
export declare function samePointer(left: VersionPointer | null, right: VersionPointer): boolean;
//# sourceMappingURL=activePointer.d.ts.map