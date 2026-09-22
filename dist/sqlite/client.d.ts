import { type SqliteStateBatchOptions, type SqliteStateBatchResult, type SqliteStateImportResult, type SqliteStateImportStage, type SqliteStateIntegrityResult, type SqliteStateListOptions, type SqliteStateListPage, type SqliteStateMigration, type SqliteStateMigrationResult, type SqliteStateMutation, type SqliteStateRow, type SqliteStateRuntimeInfo, type SqliteStateStoreOptions } from "./database.js";
import type { SqliteStateWorkerRequest, SqliteStateWorkerResponse } from "./protocol.js";
interface WorkerLike {
    postMessage(message: SqliteStateWorkerRequest): void;
    terminate(): void;
    addEventListener(type: "message", listener: (event: MessageEvent<SqliteStateWorkerResponse>) => void): void;
    addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
    addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
}
export type SqliteStateWorkerFactory = () => WorkerLike;
export interface SqliteStateStore {
    readonly name: string;
    get(namespace: string, key: string): Promise<SqliteStateRow | undefined>;
    list(options: SqliteStateListOptions): Promise<SqliteStateListPage>;
    put(namespace: string, key: string, value: Uint8Array, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    delete(namespace: string, key: string, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    batch(mutations: ReadonlyArray<SqliteStateMutation>, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    migrate(migration: SqliteStateMigration): Promise<SqliteStateMigrationResult>;
    checkIntegrity(): Promise<SqliteStateIntegrityResult>;
    exportBytes(): Promise<Uint8Array>;
    stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage>;
    discardImport(stageId: string): Promise<void>;
    commitImport(stageId: string, options?: SqliteStateBatchOptions): Promise<SqliteStateImportResult>;
    reset(options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    runtimeInfo(): Promise<SqliteStateRuntimeInfo>;
    dispose(): Promise<void>;
}
/** Main-thread proxy for the dedicated SQLite Worker. */
export declare class SqliteStateStoreClient implements SqliteStateStore {
    #private;
    readonly name: string;
    constructor(options: SqliteStateStoreOptions, workerFactory?: SqliteStateWorkerFactory);
    ready(): Promise<void>;
    get(namespace: string, key: string): Promise<SqliteStateRow | undefined>;
    list(options: SqliteStateListOptions): Promise<SqliteStateListPage>;
    put(namespace: string, key: string, value: Uint8Array, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    delete(namespace: string, key: string, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    batch(mutations: ReadonlyArray<SqliteStateMutation>, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    migrate(migration: SqliteStateMigration): Promise<SqliteStateMigrationResult>;
    checkIntegrity(): Promise<SqliteStateIntegrityResult>;
    exportBytes(): Promise<Uint8Array>;
    stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage>;
    discardImport(stageId: string): Promise<void>;
    commitImport(stageId: string, options?: SqliteStateBatchOptions): Promise<SqliteStateImportResult>;
    reset(options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    runtimeInfo(): Promise<SqliteStateRuntimeInfo>;
    dispose(): Promise<void>;
}
export declare function createSqliteStateStore(options: SqliteStateStoreOptions): Promise<SqliteStateStore>;
export {};
//# sourceMappingURL=client.d.ts.map