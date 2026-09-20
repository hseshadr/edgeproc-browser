import { describe, expect, it } from "vitest";
import { PackedVectorIndex } from "./packed.js";

describe("PackedVectorIndex", () => {
	it("searches an immutable packed matrix synchronously with stable ordered ties", () => {
		const index = new PackedVectorIndex(
			new Float32Array([1, 0, 0, 1, 1, 0]),
			["first", "second", "third"],
			2,
		);

		expect(index.search(new Float32Array([1, 0]), 3)).toEqual([
			{ id: "first", similarity: 1 },
			{ id: "third", similarity: 1 },
			{ id: "second", similarity: 0 },
		]);
		expect(index.similarityOf("second", new Float32Array([0, 1]))).toBe(1);
		expect(() =>
			index.similarityOf("missing", new Float32Array([0, 1])),
		).toThrow(RangeError);
	});

	it("returns ids and defensive vector copies by producer row", () => {
		const index = new PackedVectorIndex(
			new Float32Array([1, 2, 3, 4]),
			["a", "b"],
			2,
		);
		const vector = index.vectorAt(1);
		vector.fill(0);

		expect(index.idAt(1)).toBe("b");
		expect(index.vectorAt(1)).toEqual(new Float32Array([3, 4]));
		expect(() => index.vectorAt(2)).toThrow(RangeError);
	});

	it("copies inputs and rejects malformed matrices, ids, queries, and limits", () => {
		const matrix = new Float32Array([1, 0, 0, 1]);
		const index = new PackedVectorIndex(matrix, ["a", "b"], 2);
		matrix.fill(0);
		expect(index.similarityOf("a", new Float32Array([1, 0]))).toBe(1);

		expect(
			() => new PackedVectorIndex(new Float32Array(3), ["a", "b"], 2),
		).toThrow(/matrix/iu);
		expect(
			() => new PackedVectorIndex(new Float32Array(4), ["a", "a"], 2),
		).toThrow(/duplicate/iu);
		expect(
			() => new PackedVectorIndex(new Float32Array([1, Number.NaN]), ["a"], 2),
		).toThrow(/non-finite/iu);
		expect(() => index.search(new Float32Array([1]), 1)).toThrow(/dimension/iu);
		expect(() => index.search(new Float32Array([1, 0]), -1)).toThrow(/limit/iu);
	});

	it("zeroizes owned storage on idempotent disposal and then fails closed", () => {
		const index = new PackedVectorIndex(new Float32Array([1, 0]), ["a"], 2);

		index.dispose();
		index.dispose();

		expect(() => index.search(new Float32Array([1, 0]), 1)).toThrow(
			/disposed/iu,
		);
		expect(() => index.similarityOf("a", new Float32Array([1, 0]))).toThrow(
			/disposed/iu,
		);
		expect(() => index.vectorAt(0)).toThrow(/disposed/iu);
	});
});
