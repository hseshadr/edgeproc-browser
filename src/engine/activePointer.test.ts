import { describe, expect, it } from "vitest";
import { parseStoredPointer, samePointer } from "./activePointer.js";

const base = {
	manifest_hash: "a".repeat(64),
	version: "v1",
	sequence: 1,
	signature: "signed",
};

describe("durable active pointer parser", () => {
	it("bounds optional signed identity strings", () => {
		expect(
			parseStoredPointer({ ...base, bundle_id: "bundle", channel: null }),
		).toEqual({
			...base,
			bundle_id: "bundle",
			channel: null,
		});
		expect(
			parseStoredPointer({ ...base, bundle_id: "x".repeat(201) }),
		).toBeNull();
		expect(
			parseStoredPointer({ ...base, channel: "x".repeat(201) }),
		).toBeNull();
	});

	it("loads records that predate key_id/expires_at", () => {
		expect(parseStoredPointer(base)).toEqual(base);
	});

	it("keeps well-formed key_id and expires_at", () => {
		const signed = {
			...base,
			key_id: "34750f98bd59fcfc",
			expires_at: 1_767_225_600,
		};
		expect(parseStoredPointer(signed)).toEqual(signed);
		expect(
			parseStoredPointer({ ...base, key_id: null, expires_at: null }),
		).toEqual({ ...base, key_id: null, expires_at: null });
	});

	it.each([
		["an uppercase key_id", { key_id: "34750F98BD59FCFC" }],
		["a short key_id", { key_id: "34750f98" }],
		["a numeric key_id", { key_id: 1 }],
		["a zero expires_at", { expires_at: 0 }],
		["a fractional expires_at", { expires_at: 1.5 }],
		["an unsafe expires_at", { expires_at: 2 ** 53 }],
		["a string expires_at", { expires_at: "1" }],
	])("refuses %s", (_label, field) => {
		expect(parseStoredPointer({ ...base, ...field })).toBeNull();
	});
});

describe("durable pointer equality", () => {
	it("treats absent and null new fields as the same legacy pointer", () => {
		expect(samePointer(base, { ...base, key_id: null, expires_at: null })).toBe(
			true,
		);
	});

	it.each([
		["key_id", { key_id: "34750f98bd59fcfc" }],
		["expires_at", { expires_at: 1_767_225_600 }],
	])("distinguishes pointers that differ only in %s", (_label, field) => {
		expect(samePointer(base, { ...base, ...field })).toBe(false);
		expect(samePointer({ ...base, ...field }, { ...base, ...field })).toBe(
			true,
		);
	});
});
