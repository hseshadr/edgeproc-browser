export {
	createSqliteVectorIndex,
	SqliteVectorIndexClient,
	type SqliteVectorWorkerFactory,
	type SqliteWorkerVectorIndex,
} from "./client.js";
export {
	type SqliteDatabase,
	SqliteDatabaseVectorIndex,
	type SqliteValue,
	type SqliteVectorRuntimeInfo,
} from "./database.js";
export type {
	SqliteVectorPersistence,
	SqliteVectorWorkerOptions,
} from "./protocol.js";
