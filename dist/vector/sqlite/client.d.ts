import type { Metadata, VectorHit, VectorIndex, VectorIndexCapabilities, VectorRecord, VectorStats } from "../types.js";
import type { SqliteVectorRuntimeInfo } from "./database.js";
import type { SqliteVectorWorkerOptions, SqliteVectorWorkerRequest, SqliteVectorWorkerResponse } from "./protocol.js";
interface WorkerLike {
    postMessage(message: SqliteVectorWorkerRequest): void;
    terminate(): void;
    addEventListener(type: "message", listener: (event: MessageEvent<SqliteVectorWorkerResponse>) => void): void;
    addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
    addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
}
export type SqliteVectorWorkerFactory = () => WorkerLike;
export interface SqliteWorkerVectorIndex extends VectorIndex {
    runtimeInfo(): Promise<SqliteVectorRuntimeInfo>;
}
/** Worker proxy that keeps synchronous SQLite and OPFS access off the UI thread. */
export declare class SqliteVectorIndexClient implements SqliteWorkerVectorIndex {
    #private;
    readonly name: string;
    readonly dimension: number;
    readonly capabilities: VectorIndexCapabilities;
    constructor(options: SqliteVectorWorkerOptions, workerFactory?: SqliteVectorWorkerFactory);
    ready(): Promise<void>;
    insert(records: ReadonlyArray<VectorRecord>): Promise<void>;
    read(id: string): Promise<VectorRecord | undefined>;
    search(query: Float32Array, limit: number, filters?: Metadata): Promise<ReadonlyArray<VectorHit>>;
    delete(ids: ReadonlyArray<string>, filters?: Metadata): Promise<number>;
    deleteWhere(filters: Metadata): Promise<number>;
    clear(): Promise<number>;
    stats(filters?: Metadata): Promise<VectorStats>;
    runtimeInfo(): Promise<SqliteVectorRuntimeInfo>;
    dispose(): Promise<void>;
}
export declare function createSqliteVectorIndex(options: SqliteVectorWorkerOptions): Promise<SqliteWorkerVectorIndex>;
export {};
//# sourceMappingURL=client.d.ts.map