import {
	applicationId,
	internalSchemaVersion,
	type SqliteStateDatabase,
	type SqliteStateDatabaseHandle,
	type SqliteStateRow,
	type SqliteStateRuntime,
	type SqliteStateSnapshot,
} from "./database.js";

interface SqliteStateModule {
	readonly oo1: {
		readonly DB: new (filename: string) => SqliteStateDatabaseHandle;
		readonly OpfsWlDb?: new (filename: string) => SqliteStateDatabaseHandle;
	};
	readonly capi: {
		readonly SQLITE_OK: number;
		sqlite3_deserialize(
			database: number | bigint,
			schema: string,
			bytes: number | bigint,
			size: bigint,
			bufferSize: bigint,
			flags: number,
		): number;
		sqlite3_js_db_export(
			database: SqliteStateDatabaseHandle | number | bigint,
		): Uint8Array;
		sqlite3_errstr(code: number): string;
	};
	readonly wasm: {
		allocFromTypedArray(bytes: Uint8Array): number | bigint;
		dealloc(pointer: number | bigint): void;
	};
}

const SQLITE_DESERIALIZE_READONLY = 4;
const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");

/** Bind the official SQLite OO1 runtime without exposing SQL to consumers. */
export function createSqliteStateRuntime(
	sqlite: SqliteStateModule,
	raw: SqliteStateDatabaseHandle,
): SqliteStateRuntime {
	const database = wrapDatabase(raw);
	return {
		database,
		exportBytes: () => sqlite.capi.sqlite3_js_db_export(raw),
		readSnapshot: (bytes) => readSnapshot(sqlite, bytes),
	};
}

function wrapDatabase(raw: SqliteStateDatabaseHandle): SqliteStateDatabase {
	return {
		exec: (sql, bind) => {
			raw.exec(bind === undefined ? { sql } : { sql, bind: [...bind] });
		},
		selectObjects: (sql, bind) =>
			raw.selectObjects(sql, bind === undefined ? undefined : [...bind]),
		// Acquire SQLite's write lock before reading the CAS epoch. A deferred
		// transaction lets two tabs both validate the same epoch before either
		// upgrades its lock, which turns compare-and-swap into last-writer-wins.
		transaction: (callback) => raw.transaction("IMMEDIATE", callback),
		close: () => raw.close(),
	};
}

function readSnapshot(
	sqlite: SqliteStateModule,
	bytes: Uint8Array,
): SqliteStateSnapshot {
	if (!hasSqliteHeader(bytes)) {
		throw new Error("import is not a SQLite database");
	}
	const raw = new sqlite.oo1.DB(":memory:");
	const pointer = sqlite.wasm.allocFromTypedArray(bytes);
	try {
		const result = sqlite.capi.sqlite3_deserialize(
			raw.pointer,
			"main",
			pointer,
			BigInt(bytes.byteLength),
			BigInt(bytes.byteLength),
			SQLITE_DESERIALIZE_READONLY,
		);
		if (result !== sqlite.capi.SQLITE_OK) {
			throw new Error(
				`could not read SQLite database (${sqlite.capi.sqlite3_errstr(result)})`,
			);
		}
		raw.exec({ sql: "PRAGMA trusted_schema = OFF; PRAGMA query_only = ON" });
		validateImportedSchema(raw);
		const integrity = raw.selectObjects("PRAGMA integrity_check(1)")[0]
			?.integrity_check;
		if (integrity !== "ok") {
			throw new Error(
				`imported SQLite database failed integrity check: ${String(integrity)}`,
			);
		}
		const meta = new Map(
			raw
				.selectObjects(
					"SELECT key, value FROM edgeproc_state_meta ORDER BY key COLLATE BINARY",
				)
				.map((row) => [requireString(row.key, "metadata key"), row.value]),
		);
		if (meta.size !== 2 || !meta.has("schema_version") || !meta.has("epoch")) {
			throw new Error("imported metadata schema is invalid");
		}
		const schemaVersion = requireNonNegativeInteger(
			meta.get("schema_version"),
			"imported schema version",
		);
		if (schemaVersion < 1)
			throw new Error("imported schema version is invalid");
		const epoch = requireNonNegativeInteger(
			meta.get("epoch"),
			"imported epoch",
		);
		const rows = raw
			.selectObjects(
				"SELECT namespace, key, value, revision FROM edgeproc_state_rows ORDER BY namespace COLLATE BINARY, key COLLATE BINARY",
			)
			.map(decodeImportedRow);
		return { schemaVersion, epoch, rows };
	} catch (error) {
		if (
			error instanceof Error &&
			/not an edgeproc state database/.test(error.message)
		) {
			throw error;
		}
		if (
			error instanceof Error &&
			/SQLite database|integrity|schema|epoch|state row|metadata/.test(
				error.message,
			)
		) {
			throw error;
		}
		throw new Error(
			`could not validate imported SQLite database (${error instanceof Error ? error.message : String(error)})`,
		);
	} finally {
		raw.close();
		sqlite.wasm.dealloc(pointer);
	}
}

function validateImportedSchema(raw: SqliteStateDatabaseHandle): void {
	const appId = requireNonNegativeInteger(
		raw.selectObjects("PRAGMA application_id")[0]?.application_id,
		"SQLite application id",
	);
	const userVersion = requireNonNegativeInteger(
		raw.selectObjects("PRAGMA user_version")[0]?.user_version,
		"SQLite internal schema version",
	);
	if (appId !== applicationId() || userVersion !== internalSchemaVersion()) {
		throw new Error("import is not an edgeproc state database");
	}
	const objects = raw.selectObjects(
		"SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
	);
	const signatures = objects.map(
		(row) => `${String(row.type)}:${String(row.name)}`,
	);
	if (
		signatures.length !== 3 ||
		signatures[0] !== "table:_sqliteai_vector" ||
		signatures[1] !== "table:edgeproc_state_meta" ||
		signatures[2] !== "table:edgeproc_state_rows"
	) {
		throw new Error(
			`imported edgeproc state database has an unsupported schema (${signatures.join(", ")})`,
		);
	}
	validateColumns(raw, "edgeproc_state_meta", [
		["key", "TEXT", 1, 1],
		["value", "INTEGER", 1, 0],
	]);
	validateColumns(raw, "edgeproc_state_rows", [
		["namespace", "TEXT", 1, 1],
		["key", "TEXT", 1, 2],
		["value", "BLOB", 1, 0],
		["revision", "INTEGER", 1, 0],
	]);
}

function validateColumns(
	raw: SqliteStateDatabaseHandle,
	table: string,
	expected: ReadonlyArray<
		readonly [name: string, type: string, notNull: number, primaryKey: number]
	>,
): void {
	const columns = raw.selectObjects(`PRAGMA table_info(${table})`);
	const actual = columns.map((row) => [
		row.name,
		row.type,
		row.notnull,
		row.pk,
	]);
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			"imported edgeproc state database has an unsupported schema",
		);
	}
}

function decodeImportedRow(row: Record<string, unknown>): SqliteStateRow {
	const namespace = requireString(
		row.namespace,
		"imported state row namespace",
	);
	const key = requireString(row.key, "imported state row key");
	const value = row.value;
	if (!(value instanceof Uint8Array)) {
		throw new Error("imported state row value is not a BLOB");
	}
	return {
		namespace,
		key,
		value: value.slice(),
		revision: requireNonNegativeInteger(
			row.revision,
			"imported state row revision",
		),
	};
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= SQLITE_HEADER.byteLength &&
		SQLITE_HEADER.every((value, index) => bytes[index] === value)
	);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is not text`);
	return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} is not a non-negative safe integer`);
	}
	return value;
}

export type { SqliteStateModule };
