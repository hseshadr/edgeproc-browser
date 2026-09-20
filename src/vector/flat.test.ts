import { describe, expect, it } from "vitest";
import {
	assertVectorIndexConformance,
	FlatVectorIndex,
	type VectorIndexFactory,
} from "./index";

const factory: VectorIndexFactory = (options) => new FlatVectorIndex(options);

describe("FlatVectorIndex", () => {
	it("satisfies the reusable VectorIndex contract", async () => {
		await expect(
			assertVectorIndexConformance(factory),
		).resolves.toBeUndefined();
	});

	it("advertises its exact, in-memory capabilities", () => {
		const index = new FlatVectorIndex({ name: "capabilities", dimension: 3 });

		expect(index.capabilities).toEqual({
			metrics: ["cosine"],
			exact: true,
			persistent: false,
			metadataFiltering: true,
			scopedDelete: true,
		});
	});

	it("disposes idempotently and refuses use after disposal", async () => {
		const index = new FlatVectorIndex({ name: "dispose", dimension: 2 });
		await index.insert([
			{
				id: "row",
				vector: new Float32Array([1, 0]),
				metadata: {},
			},
		]);

		await index.dispose();
		await expect(index.dispose()).resolves.toBeUndefined();
		await expect(index.read("row")).rejects.toThrow(/disposed/);
		await expect(index.stats()).rejects.toThrow(/disposed/);
	});
});
