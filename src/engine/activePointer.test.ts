import { describe, expect, it } from "vitest";
import { parseStoredPointer } from "./activePointer.js";

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
});
