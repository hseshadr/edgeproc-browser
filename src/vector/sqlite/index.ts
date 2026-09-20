export {
	createSqliteVectorIndex,
	SqliteVectorIndexClient,
	type SqliteVectorWorkerFactory,
	type SqliteWorkerVectorIndex,
} from "./client";
export {
	type SqliteDatabase,
	SqliteDatabaseVectorIndex,
	type SqliteValue,
	type SqliteVectorRuntimeInfo,
} from "./database";
export type {
	SqliteVectorPersistence,
	SqliteVectorWorkerOptions,
} from "./protocol";
