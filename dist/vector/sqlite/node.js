/// <reference types="node" />
/**
 * Node-only SQLite vector adapter for local recall and evaluation workflows.
 *
 * This is intentionally a separate export: the normal browser entrypoint
 * remains free of Node imports and keeps OPFS in its dedicated Worker.
 */
import { readFile } from "node:fs/promises";
import sqlite3InitModule from "./assets/sqlite3.mjs";
import { SqliteDatabaseVectorIndex, wrapSqliteDatabase } from "./database.js";
/** Open the pinned SQLite/sqlite-vector WASM runtime in an in-memory Node DB. */
export async function createNodeSqliteVectorIndex(options) {
    const wasm = new Uint8Array(await readFile(new URL("./assets/sqlite3.wasm", import.meta.url)));
    const sqlite = await sqlite3InitModule({
        wasmBinary: wasm,
        print: () => undefined,
        printErr: () => undefined,
    });
    const index = new SqliteDatabaseVectorIndex(options, wrapSqliteDatabase(new sqlite.oo1.DB(":memory:")), false);
    assertPinnedRuntime(index);
    return index;
}
function assertPinnedRuntime(index) {
    const runtime = index.runtimeInfo();
    if (runtime.sqliteVersion !== "3.53.4" ||
        runtime.vectorVersion !== "1.1.2" ||
        runtime.vectorBackend !== "CPU" ||
        runtime.bundledExtensions.join(",") !== "vector_version") {
        void index.dispose();
        throw new Error(`unexpected SQLite vector runtime: ${JSON.stringify(runtime)}`);
    }
}
//# sourceMappingURL=node.js.map