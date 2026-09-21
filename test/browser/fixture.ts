import {
	createSqliteVectorIndex,
	type SqliteVectorRuntimeInfo,
} from "@edgeproc/browser/vector/sqlite";

export interface BrowserProof {
	readonly runtime: SqliteVectorRuntimeInfo;
	readonly firstNearest: string | undefined;
	readonly namedIds: ReadonlyArray<string>;
	readonly keyedIds: ReadonlyArray<string>;
	readonly deletedWhere: number;
	readonly reopenedNearest: string | undefined;
	readonly reopenedCount: number;
	readonly cleared: number;
}

declare global {
	interface Window {
		runSqliteVectorProof(name: string): Promise<BrowserProof>;
	}
}

window.runSqliteVectorProof = async (name): Promise<BrowserProof> => {
	const first = await createSqliteVectorIndex({
		name,
		dimension: 3,
		persistence: "opfs",
	});
	const runtime = await first.runtimeInfo();
	await first.insert([
		{
			id: "closest",
			vector: new Float32Array([1, 0, 0]),
			metadata: { tenant: "browser", active: true },
		},
		{
			id: "far",
			vector: new Float32Array([0, 1, 0]),
			metadata: { tenant: "browser", active: false },
		},
	]);
	await first.insertKeyed([
		{
			id: "keyed",
			vector: new Float32Array([0, 0, 1]),
			metadata: { tenant: "browser", active: true },
			lookupKeys: [{ namespace: "token", value: "portable" }],
		},
	]);
	const firstNearest = (
		await first.search(new Float32Array([0.9, 0.1, 0]), 1, {
			tenant: "browser",
			active: true,
		})
	)[0]?.id;
	const namedIds = (
		await first.searchByIds(new Float32Array([0.9, 0.1, 0]), [
			"far",
			"closest",
			"missing",
			"closest",
		])
	).map(({ id }) => id);
	const keyedIds = await first.lookupIds(
		[{ namespace: "token", value: "portable" }],
		1,
	);
	const deletedWhere = await first.deleteWhere({ active: false });
	await first.dispose();

	const reopened = await createSqliteVectorIndex({
		name,
		dimension: 3,
		persistence: "opfs",
	});
	const reopenedNearest = (
		await reopened.search(new Float32Array([0.9, 0.1, 0]), 1)
	)[0]?.id;
	const reopenedCount = (await reopened.stats()).vectorCount;
	const cleared = await reopened.clear();
	const remaining = await reopened.stats();
	await reopened.dispose();

	if (remaining.vectorCount !== 0) {
		throw new Error("clear left persistent vectors behind");
	}
	return {
		runtime,
		firstNearest,
		namedIds,
		keyedIds,
		deletedWhere,
		reopenedNearest,
		reopenedCount,
		cleared,
	};
};
