import { type SqliteStateDatabaseHandle, type SqliteStateRuntime } from "./database.js";
interface SqliteStateModule {
    readonly oo1: {
        readonly DB: new (filename: string) => SqliteStateDatabaseHandle;
        readonly OpfsWlDb?: new (filename: string) => SqliteStateDatabaseHandle;
    };
    readonly capi: {
        readonly SQLITE_OK: number;
        sqlite3_deserialize(database: number | bigint, schema: string, bytes: number | bigint, size: bigint, bufferSize: bigint, flags: number): number;
        sqlite3_js_db_export(database: SqliteStateDatabaseHandle | number | bigint): Uint8Array;
        sqlite3_errstr(code: number): string;
    };
    readonly wasm: {
        allocFromTypedArray(bytes: Uint8Array): number | bigint;
        dealloc(pointer: number | bigint): void;
    };
}
/** Bind the official SQLite OO1 runtime without exposing SQL to consumers. */
export declare function createSqliteStateRuntime(sqlite: SqliteStateModule, raw: SqliteStateDatabaseHandle): SqliteStateRuntime;
export type { SqliteStateModule };
//# sourceMappingURL=runtime.d.ts.map