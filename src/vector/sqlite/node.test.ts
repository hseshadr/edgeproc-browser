// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createNodeSqliteVectorIndex } from "./node";

describe("createNodeSqliteVectorIndex", () => {
	it("does not emit irrelevant OPFS auto-install warnings", async () => {
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const originalLocation = Object.getOwnPropertyDescriptor(
			globalThis,
			"location",
		);
		try {
			const index = await createNodeSqliteVectorIndex({
				name: "node-warning-free",
				dimension: 2,
			});
			await index.dispose();
			expect(error).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(globalThis, "location")).toEqual(
				originalLocation,
			);
		} finally {
			error.mockRestore();
		}
	});

	it("runs the pinned sqlite-vector runtime and exact deletion semantics in memory", async () => {
		const index = await createNodeSqliteVectorIndex({
			name: "node-recall",
			dimension: 2,
		});
		await index.insert([
			{
				id: "keep",
				vector: new Float32Array([1, 0]),
				metadata: { tenant: "a", active: true },
			},
			{
				id: "remove",
				vector: new Float32Array([0, 1]),
				metadata: { tenant: "a", active: false },
			},
		]);

		expect(index.runtimeInfo()).toMatchObject({
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			bundledExtensions: ["vector_version"],
		});
		expect(
			(
				await index.searchByIds(new Float32Array([1, 0]), ["remove", "keep"])
			).map(({ id }) => id),
		).toEqual(["keep", "remove"]);
		expect(await index.deleteWhere({ active: false })).toBe(1);
		expect((await index.search(new Float32Array([1, 0]), 1))[0]?.id).toBe(
			"keep",
		);
		expect(await index.clear()).toBe(1);
		expect((await index.stats()).vectorCount).toBe(0);
		await index.dispose();
		await expect(index.clear()).rejects.toThrow(/disposed/);
	});
});
