// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createNodeSqliteVectorIndex } from "./node";

describe("createNodeSqliteVectorIndex", () => {
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
