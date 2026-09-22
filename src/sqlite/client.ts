import {
	type SqliteStateBatchOptions,
	type SqliteStateBatchResult,
	SqliteStateConflictError,
	type SqliteStateImportResult,
	type SqliteStateImportStage,
	type SqliteStateIntegrityResult,
	type SqliteStateListOptions,
	type SqliteStateListPage,
	type SqliteStateMigration,
	type SqliteStateMigrationResult,
	type SqliteStateMutation,
	type SqliteStateRow,
	type SqliteStateRuntimeInfo,
	SqliteStateSchemaError,
	type SqliteStateStoreOptions,
} from "./database.js";
import type {
	SqliteStateWorkerRequest,
	SqliteStateWorkerResponse,
} from "./protocol.js";

interface WorkerLike {
	postMessage(message: SqliteStateWorkerRequest): void;
	terminate(): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<SqliteStateWorkerResponse>) => void,
	): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(
		type: "messageerror",
		listener: (event: MessageEvent<unknown>) => void,
	): void;
}

export type SqliteStateWorkerFactory = () => WorkerLike;

export interface SqliteStateStore {
	readonly name: string;
	get(namespace: string, key: string): Promise<SqliteStateRow | undefined>;
	list(options: SqliteStateListOptions): Promise<SqliteStateListPage>;
	put(
		namespace: string,
		key: string,
		value: Uint8Array,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateBatchResult>;
	delete(
		namespace: string,
		key: string,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateBatchResult>;
	batch(
		mutations: ReadonlyArray<SqliteStateMutation>,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateBatchResult>;
	migrate(migration: SqliteStateMigration): Promise<SqliteStateMigrationResult>;
	checkIntegrity(): Promise<SqliteStateIntegrityResult>;
	exportBytes(): Promise<Uint8Array>;
	stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage>;
	discardImport(stageId: string): Promise<void>;
	commitImport(
		stageId: string,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateImportResult>;
	reset(options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
	runtimeInfo(): Promise<SqliteStateRuntimeInfo>;
	dispose(): Promise<void>;
}

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
};

type RequestWithoutId = SqliteStateWorkerRequest extends infer Request
	? Request extends { readonly id: number }
		? Omit<Request, "id">
		: never
	: never;

/** Main-thread proxy for the dedicated SQLite Worker. */
export class SqliteStateStoreClient implements SqliteStateStore {
	public readonly name: string;
	readonly #worker: WorkerLike;
	readonly #pending = new Map<number, Pending>();
	readonly #ready: Promise<void>;
	#nextId = 1;
	#disposed = false;
	#terminalError: Error | undefined;

	public constructor(
		options: SqliteStateStoreOptions,
		workerFactory: SqliteStateWorkerFactory = defaultWorkerFactory,
	) {
		this.name = options.name;
		this.#worker = workerFactory();
		this.#worker.addEventListener("message", (event) =>
			this.#receive(event.data),
		);
		this.#worker.addEventListener("error", (event) => {
			this.#failTerminal(
				new Error(`SQLite state worker failed: ${event.message}`),
			);
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#failTerminal(
				new Error("SQLite state worker returned an unreadable message"),
			);
		});
		this.#ready = this.#request({ operation: "initialize", options })
			.then(() => undefined)
			.catch((reason: unknown) => {
				const error =
					reason instanceof Error ? reason : new Error(String(reason));
				this.#failTerminal(error);
				throw error;
			});
	}

	public ready(): Promise<void> {
		return this.#ready;
	}

	public async get(
		namespace: string,
		key: string,
	): Promise<SqliteStateRow | undefined> {
		await this.#ready;
		return (await this.#request({
			operation: "get",
			namespace,
			key,
		})) as SqliteStateRow | undefined;
	}

	public async list(
		options: SqliteStateListOptions,
	): Promise<SqliteStateListPage> {
		await this.#ready;
		return (await this.#request({
			operation: "list",
			options,
		})) as SqliteStateListPage;
	}

	public put(
		namespace: string,
		key: string,
		value: Uint8Array,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		return this.batch([{ type: "put", namespace, key, value }], options);
	}

	public delete(
		namespace: string,
		key: string,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		return this.batch([{ type: "delete", namespace, key }], options);
	}

	public async batch(
		mutations: ReadonlyArray<SqliteStateMutation>,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		await this.#ready;
		return (await this.#request({
			operation: "batch",
			mutations,
			options,
		})) as SqliteStateBatchResult;
	}

	public async migrate(
		migration: SqliteStateMigration,
	): Promise<SqliteStateMigrationResult> {
		await this.#ready;
		return (await this.#request({
			operation: "migrate",
			migration,
		})) as SqliteStateMigrationResult;
	}

	public async checkIntegrity(): Promise<SqliteStateIntegrityResult> {
		await this.#ready;
		return (await this.#request({
			operation: "integrity-check",
		})) as SqliteStateIntegrityResult;
	}

	public async exportBytes(): Promise<Uint8Array> {
		await this.#ready;
		return (await this.#request({ operation: "export" })) as Uint8Array;
	}

	public async stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage> {
		await this.#ready;
		return (await this.#request({
			operation: "stage-import",
			bytes,
		})) as SqliteStateImportStage;
	}

	public async discardImport(stageId: string): Promise<void> {
		await this.#ready;
		await this.#request({ operation: "discard-import", stageId });
	}

	public async commitImport(
		stageId: string,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateImportResult> {
		await this.#ready;
		return (await this.#request({
			operation: "commit-import",
			stageId,
			options,
		})) as SqliteStateImportResult;
	}

	public async reset(
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		await this.#ready;
		return (await this.#request({
			operation: "reset",
			options,
		})) as SqliteStateBatchResult;
	}

	public async runtimeInfo(): Promise<SqliteStateRuntimeInfo> {
		await this.#ready;
		return (await this.#request({
			operation: "runtime-info",
		})) as SqliteStateRuntimeInfo;
	}

	public async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			await this.#ready;
			await this.#request({ operation: "dispose" }, true);
		} finally {
			this.#worker.terminate();
			this.#failAll(new Error("SQLite state store is disposed"));
		}
	}

	#request(request: RequestWithoutId, allowDisposed = false): Promise<unknown> {
		if (this.#disposed && !allowDisposed) {
			return Promise.reject(new Error("SQLite state store is disposed"));
		}
		if (this.#terminalError !== undefined) {
			return Promise.reject(this.#terminalError);
		}
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({ ...request, id } as SqliteStateWorkerRequest);
		});
	}

	#receive(response: SqliteStateWorkerResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) return;
		this.#pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(reconstructError(response.error));
		}
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#failTerminal(error: Error): void {
		this.#terminalError = error;
		this.#worker.terminate();
		this.#failAll(error);
	}
}

export async function createSqliteStateStore(
	options: SqliteStateStoreOptions,
): Promise<SqliteStateStore> {
	const store = new SqliteStateStoreClient(options);
	await store.ready();
	return store;
}

function reconstructError(error: {
	readonly name: string;
	readonly message: string;
}): Error {
	if (error.name === "SqliteStateConflictError") {
		return new SqliteStateConflictError(error.message);
	}
	if (error.name === "SqliteStateSchemaError") {
		return new SqliteStateSchemaError(error.message);
	}
	const reconstructed = new Error(error.message);
	reconstructed.name = error.name;
	return reconstructed;
}

function defaultWorkerFactory(): WorkerLike {
	return new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
		name: "edgeproc-sqlite-state",
	});
}
