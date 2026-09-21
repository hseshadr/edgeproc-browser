/// <reference types="node" />

/**
 * Node-only SQLite vector adapter for local recall and evaluation workflows.
 *
 * This is intentionally a separate export: the normal browser entrypoint
 * remains free of Node imports and keeps OPFS in its dedicated Worker.
 */

import { readFile } from "node:fs/promises";

import type { VectorIndexOptions } from "../types.js";
import sqlite3InitModule from "./assets/sqlite3.mjs";
import { SqliteDatabaseVectorIndex, wrapSqliteDatabase } from "./database.js";

let initializationQueue = Promise.resolve();

/** Open the pinned SQLite/sqlite-vector WASM runtime in an in-memory Node DB. */
export async function createNodeSqliteVectorIndex(
	options: VectorIndexOptions,
): Promise<SqliteDatabaseVectorIndex> {
	const wasm = new Uint8Array(
		await readFile(new URL("./assets/sqlite3.wasm", import.meta.url)),
	);
	const sqlite = await initializeNodeSqlite(wasm);
	const index = new SqliteDatabaseVectorIndex(
		options,
		wrapSqliteDatabase(new sqlite.oo1.DB(":memory:")),
		false,
	);
	assertPinnedRuntime(index);
	return index;
}

function initializeNodeSqlite(
	wasm: Uint8Array,
): Promise<Awaited<ReturnType<typeof sqlite3InitModule>>> {
	const initialize = async (): Promise<
		Awaited<ReturnType<typeof sqlite3InitModule>>
	> => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "location");
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { href: "https://edgeproc.invalid/?opfs-disable&opfs-wl-disable" },
		});
		try {
			return await sqlite3InitModule({
				wasmBinary: wasm,
				print: () => undefined,
				printErr: () => undefined,
			});
		} finally {
			if (original === undefined) {
				delete (globalThis as { location?: unknown }).location;
			} else {
				Object.defineProperty(globalThis, "location", original);
			}
		}
	};
	const next = initializationQueue.then(initialize, initialize);
	initializationQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function assertPinnedRuntime(index: SqliteDatabaseVectorIndex): void {
	const runtime = index.runtimeInfo();
	if (
		runtime.sqliteVersion !== "3.53.4" ||
		runtime.vectorVersion !== "1.1.2" ||
		runtime.vectorBackend !== "CPU" ||
		runtime.bundledExtensions.join(",") !== "vector_version"
	) {
		void index.dispose();
		throw new Error(
			`unexpected SQLite vector runtime: ${JSON.stringify(runtime)}`,
		);
	}
}
