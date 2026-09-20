import type { VersionPointer } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/u;

/** Parse untrusted durable state without granting it rollback authority. */
export function parseStoredPointer(value: unknown): VersionPointer | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const pointer = value as Partial<VersionPointer>;
	if (
		typeof pointer.manifest_hash !== "string" ||
		!SHA256.test(pointer.manifest_hash) ||
		!boundedString(pointer.version, 200) ||
		!boundedString(pointer.signature, 512) ||
		!storedSequence(pointer.sequence) ||
		!optionalBoundedString(pointer.bundle_id, 200) ||
		!optionalBoundedString(pointer.channel, 200)
	) {
		return null;
	}
	return pointer as VersionPointer;
}

function storedSequence(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(Number.isSafeInteger(value) && (value as number) >= 0)
	);
}

export function samePointer(
	left: VersionPointer | null,
	right: VersionPointer,
): boolean {
	return (
		left !== null &&
		left.manifest_hash === right.manifest_hash &&
		left.version === right.version &&
		left.sequence === right.sequence &&
		left.signature === right.signature &&
		(left.bundle_id ?? null) === (right.bundle_id ?? null) &&
		(left.channel ?? null) === (right.channel ?? null)
	);
}

function boundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum
	);
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "string" && value.length <= maximum)
	);
}
