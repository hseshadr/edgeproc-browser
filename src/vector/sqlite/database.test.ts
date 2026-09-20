// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertVectorIndexConformance } from "../conformance";
import type { VectorIndexFactory } from "../types";
import sqlite3InitModule from "./assets/sqlite3.mjs";
import { type SqliteDatabase, SqliteDatabaseVectorIndex } from "./database";

interface RawDatabase {
	exec(options: { sql: string; bind?: unknown[] }): unknown;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

const wasm = new Uint8Array(
	readFileSync(new URL("./assets/sqlite3.wasm", import.meta.url)),
);
const modulePromise = sqlite3InitModule({
	wasmBinary: wasm,
	print: () => undefined,
	printErr: () => undefined,
});

async function openMemoryDatabase(): Promise<SqliteDatabase> {
	const sqlite = await modulePromise;
	const raw: RawDatabase = new sqlite.oo1.DB(":memory:");
	return {
		exec: (sql, bind) => {
			raw.exec(bind === undefined ? { sql } : { sql, bind: [...bind] });
		},
		selectObjects: (sql, bind) =>
			raw.selectObjects(sql, bind === undefined ? undefined : [...bind]),
		transaction: (callback) => raw.transaction(callback),
		close: () => raw.close(),
	};
}

const factory: VectorIndexFactory = async (options) =>
	new SqliteDatabaseVectorIndex(options, await openMemoryDatabase(), false);

describe("SqliteDatabaseVectorIndex", () => {
	it("satisfies the reusable contract against the shipped WASM", async () => {
		await expect(
			assertVectorIndexConformance(factory),
		).resolves.toBeUndefined();
	});

	it("ships only the pinned vector extension", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "runtime", dimension: 3 },
			await openMemoryDatabase(),
			false,
		);
		expect(index.runtimeInfo()).toEqual({
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			vectorBackend: "CPU",
			bundledExtensions: ["vector_version"],
		});
		await index.dispose();
	});

	it("binds adversarial metadata keys and values instead of interpolating them", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "parameters", dimension: 2 },
			await openMemoryDatabase(),
			false,
		);
		const key = `tenant') OR 1=1 --`;
		const value = `a'); DROP TABLE edgeproc_vectors; --`;
		await index.insert([
			{
				id: "safe",
				vector: new Float32Array([1, 0]),
				metadata: { [key]: value },
			},
			{
				id: "other",
				vector: new Float32Array([1, 0]),
				metadata: { [key]: "other" },
			},
		]);

		expect(
			(await index.search(new Float32Array([1, 0]), 10, { [key]: value })).map(
				({ id }) => id,
			),
		).toEqual(["safe"]);
		expect((await index.stats()).vectorCount).toBe(2);
		await index.dispose();
	});

	it("rejects reopening a database with a different dimension", async () => {
		const database = await openMemoryDatabase();
		const first = new SqliteDatabaseVectorIndex(
			{ name: "dimension", dimension: 2 },
			database,
			false,
		);
		expect(
			() =>
				new SqliteDatabaseVectorIndex(
					{ name: "dimension", dimension: 3 },
					database,
					false,
				),
		).toThrow(/has dimension 2; requested 3/);
		await first.dispose();
	});
});
