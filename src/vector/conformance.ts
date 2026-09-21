import type {
	Metadata,
	VectorIndex,
	VectorIndexFactory,
	VectorRecord,
} from "./types.js";

const DIMENSION = 3;
const QUERY = new Float32Array([1, 0, 0]);

/**
 * Exercise the behavior every VectorIndex adapter must share.
 *
 * This intentionally has no test-runner dependency. Adapter packages can call
 * it from Vitest, Playwright, or a browser smoke test and receive one error with
 * each broken contract named.
 */
export async function assertVectorIndexConformance(
	factory: VectorIndexFactory,
): Promise<void> {
	const checks: ReadonlyArray<
		readonly [string, (index: VectorIndex) => Promise<void>]
	> = [
		["insert/read/search", checkRoundTrip],
		["batch atomicity", checkBatchAtomicity],
		["replace by id", checkReplaceById],
		["copy isolation", checkCopyIsolation],
		["AND filters", checkAndFilters],
		["empty filters are unscoped", checkEmptyFilters],
		["scoped delete", checkScopedDelete],
		["unscoped delete", checkUnscopedDelete],
		["metadata delete", checkDeleteWhere],
		["metadata delete refusal", checkDeleteWhereRefusal],
		["clear", checkClear],
		["stats", checkStats],
		["dimension refusal", checkDimensionRefusal],
		["non-finite refusal", checkNonFiniteRefusal],
		["non-scalar metadata refusal", checkNonScalarMetadataRefusal],
		["invalid limit refusal", checkInvalidLimitRefusal],
		["deterministic ties", checkDeterministicTies],
		["disposed use refusal", checkDisposedUseRefusal],
	];
	const failures: string[] = [];
	for (const [name, check] of checks) {
		let index: VectorIndex | undefined;
		try {
			index = await factory({
				name: `edgeproc-conformance-${name}`,
				dimension: DIMENSION,
			});
			await check(index);
		} catch (error) {
			failures.push(`${name}: ${errorMessage(error)}`);
		} finally {
			if (index !== undefined) {
				try {
					await index.dispose();
				} catch (error) {
					failures.push(`${name} disposal: ${errorMessage(error)}`);
				}
			}
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`VectorIndex conformance failed:\n- ${failures.join("\n- ")}`,
		);
	}
}

async function checkBatchAtomicity(index: VectorIndex): Promise<void> {
	await index.insert([record("existing", [1, 0, 0], {})]);
	await assertRejects(
		() =>
			index.insert([
				record("would-be-partial", [0, 1, 0], {}),
				record("wrong", [1, 0], {}),
			]),
		"insert accepted a batch containing the wrong dimension",
	);
	assert(
		(await index.read("would-be-partial")) === undefined,
		"a rejected insert batch partially published an earlier row",
	);
	assert(
		(await index.stats()).vectorCount === 1,
		"a rejected insert batch changed the live row count",
	);
}

async function checkReplaceById(index: VectorIndex): Promise<void> {
	await index.insert([record("same", [1, 0, 0], { revision: 1 })]);
	await index.insert([record("same", [0, 1, 0], { revision: 2 })]);
	const current = await index.read("same");
	assert(current !== undefined, "replacement lost the row");
	assert(current.vector[1] === 1, "replacement kept the old vector");
	assert(current.metadata.revision === 2, "replacement kept the old metadata");
	assert(
		(await index.stats()).vectorCount === 1,
		"replacement inserted a duplicate live row",
	);
}

async function checkCopyIsolation(index: VectorIndex): Promise<void> {
	const vector = new Float32Array([1, 0, 0]);
	const metadata: Record<string, string> = { tenant: "original" };
	await index.insert([{ id: "isolated", vector, metadata }]);
	vector[0] = 0;
	metadata.tenant = "mutated";

	const first = await index.read("isolated");
	assert(first !== undefined, "read() lost the copied row");
	assert(first.vector[0] === 1, "insert retained the caller's vector buffer");
	assert(
		first.metadata.tenant === "original",
		"insert retained the caller's metadata object",
	);
	first.vector[0] = 0;
	const second = await index.read("isolated");
	assert(second?.vector[0] === 1, "read() exposed the stored vector buffer");
}

async function checkRoundTrip(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const record = await index.read("a-hot");
	assert(record !== undefined, "read() lost an inserted row");
	assert(record.id === "a-hot", "read() returned the wrong id");
	assert(record.vector[0] === 1, "read() returned the wrong vector");
	assert(record.metadata.tenant === "a", "read() returned the wrong metadata");

	const hits = await index.search(new Float32Array([0, 1, 0]), 1);
	assert(hits.length === 1, "search() did not honor its limit");
	assert(hits[0]?.id === "a-cold", "search() did not return the nearest row");
	assert(hits[0]?.distance === 0, "an identical vector must have distance 0");
	const far = await index.search(new Float32Array([-1, 0, 0]), 4);
	assert(
		(far.at(-1)?.distance ?? 0) >=
			(far[0]?.distance ?? Number.POSITIVE_INFINITY),
		"search results must use ascending, lower-is-closer distance",
	);
}

async function checkAndFilters(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const hits = await index.search(QUERY, 100, { tenant: "a", tier: "hot" });
	assertIds(hits, ["a-hot"]);
}

async function checkEmptyFilters(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	assertIds(await index.search(QUERY, 100, {}), [
		"a-hot",
		"b-hot",
		"a-cold",
		"b-cold",
	]);
	assert(
		(await index.stats({})).vectorCount === 4,
		"stats({}) must be unscoped",
	);
}

async function checkScopedDelete(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const deleted = await index.delete(["a-hot", "b-hot"], { tenant: "a" });
	assert(deleted === 1, "scoped delete must report only matching rows");
	assert(
		(await index.read("a-hot")) === undefined,
		"matching row survived delete",
	);
	assert(
		(await index.read("b-hot")) !== undefined,
		"scoped delete crossed scope",
	);
}

async function checkUnscopedDelete(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const deleted = await index.delete(["a-hot", "b-hot"], {});
	assert(deleted === 2, "delete(ids,{}) must delete across metadata scopes");
	assert(
		(await index.stats()).vectorCount === 2,
		"unscoped delete left rows alive",
	);
}

async function checkDeleteWhere(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const deleted = await index.deleteWhere({ tenant: "a", tier: "hot" });
	assert(deleted === 1, "deleteWhere must report only matching rows");
	assert(
		(await index.read("a-hot")) === undefined,
		"deleteWhere left its matching row alive",
	);
	assert(
		(await index.read("a-cold")) !== undefined,
		"deleteWhere crossed its AND scope",
	);
}

async function checkDeleteWhereRefusal(index: VectorIndex): Promise<void> {
	await assertRejects(
		() => index.deleteWhere({}),
		"deleteWhere accepted an unscoped empty filter",
	);
	const invalid = { nested: { unsafe: true } } as unknown as Metadata;
	await assertRejects(
		() => index.deleteWhere(invalid),
		"deleteWhere accepted nested metadata",
	);
}

async function checkClear(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	assert(
		(await index.clear()) === 4,
		"clear must return its exact deleted count",
	);
	assert((await index.stats()).vectorCount === 0, "clear left a vector alive");
	assert(
		(await index.clear()) === 0,
		"clear must report zero after an empty clear",
	);
}

async function checkStats(index: VectorIndex): Promise<void> {
	await index.insert(seedRows());
	const all = await index.stats();
	assert(all.name === index.name, "stats returned the wrong index name");
	assert(all.dimension === DIMENSION, "stats returned the wrong dimension");
	assert(all.vectorCount === 4, "unscoped stats returned the wrong count");
	assert(all.vectorBytes === 48, "stats returned the wrong float32 byte count");
	const mine = await index.stats({ tenant: "a" });
	assert(mine.vectorCount === 2, "scoped stats ignored its filter");
	assert(mine.vectorBytes === 24, "scoped stats returned the wrong byte count");
}

async function checkDimensionRefusal(index: VectorIndex): Promise<void> {
	await assertRejects(
		() => index.insert([record("wrong", [1, 0], { tenant: "a" })]),
		"insert accepted the wrong dimension",
	);
	await assertRejects(
		() => index.search(new Float32Array([1, 0]), 1),
		"search accepted the wrong dimension",
	);
}

async function checkNonFiniteRefusal(index: VectorIndex): Promise<void> {
	await assertRejects(
		() => index.insert([record("nan", [Number.NaN, 0, 0], {})]),
		"insert accepted NaN",
	);
	await assertRejects(
		() => index.search(new Float32Array([Number.POSITIVE_INFINITY, 0, 0]), 1),
		"search accepted Infinity",
	);
}

async function checkNonScalarMetadataRefusal(
	index: VectorIndex,
): Promise<void> {
	const invalid = { nested: { unsafe: true } } as unknown as Metadata;
	await assertRejects(
		() => index.insert([record("nested", [1, 0, 0], invalid)]),
		"insert accepted nested metadata",
	);
	await assertRejects(
		() => index.search(QUERY, 1, invalid),
		"search accepted a nested metadata filter",
	);
}

async function checkInvalidLimitRefusal(index: VectorIndex): Promise<void> {
	for (const limit of [-1, 1.5, Number.NaN]) {
		await assertRejects(
			() => index.search(QUERY, limit),
			`search accepted invalid limit ${String(limit)}`,
		);
	}
}

async function checkDeterministicTies(index: VectorIndex): Promise<void> {
	await index.insert([
		record("z-tie", [1, 0, 0], {}),
		record("a-tie", [1, 0, 0], {}),
	]);
	assertIds(await index.search(QUERY, 2), ["a-tie", "z-tie"]);
}

async function checkDisposedUseRefusal(index: VectorIndex): Promise<void> {
	await index.dispose();
	await index.dispose();
	await assertRejects(
		() => index.search(QUERY, 1),
		"search remained usable after dispose",
	);
	await assertRejects(
		() => index.deleteWhere({ tenant: "a" }),
		"deleteWhere remained usable after dispose",
	);
	await assertRejects(
		() => index.clear(),
		"clear remained usable after dispose",
	);
}

function seedRows(): ReadonlyArray<VectorRecord> {
	return [
		record("a-hot", [1, 0, 0], { tenant: "a", tier: "hot" }),
		record("a-cold", [0, 1, 0], { tenant: "a", tier: "cold" }),
		record("b-hot", [1, 0, 0], { tenant: "b", tier: "hot" }),
		record("b-cold", [0, 0, 1], { tenant: "b", tier: "cold" }),
	];
}

function record(
	id: string,
	vector: ReadonlyArray<number>,
	metadata: Metadata,
): VectorRecord {
	return { id, vector: new Float32Array(vector), metadata };
}

function assertIds(
	hits: ReadonlyArray<{ readonly id: string }>,
	expected: ReadonlyArray<string>,
): void {
	const actual = hits.map(({ id }) => id);
	assert(
		actual.length === expected.length &&
			actual.every((id, index) => id === expected[index]),
		`expected ids ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function assertRejects(
	action: () => Promise<unknown>,
	message: string,
): Promise<void> {
	try {
		await action();
	} catch {
		return;
	}
	throw new Error(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
