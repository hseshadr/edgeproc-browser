import { SqliteStateConflictError, SqliteStateSchemaError, } from "./database.js";
/** Main-thread proxy for the dedicated SQLite Worker. */
export class SqliteStateStoreClient {
    name;
    #worker;
    #pending = new Map();
    #ready;
    #nextId = 1;
    #disposed = false;
    #terminalError;
    constructor(options, workerFactory = defaultWorkerFactory) {
        this.name = options.name;
        this.#worker = workerFactory();
        this.#worker.addEventListener("message", (event) => this.#receive(event.data));
        this.#worker.addEventListener("error", (event) => {
            this.#failTerminal(new Error(`SQLite state worker failed: ${event.message}`));
        });
        this.#worker.addEventListener("messageerror", () => {
            this.#failTerminal(new Error("SQLite state worker returned an unreadable message"));
        });
        this.#ready = this.#request({ operation: "initialize", options })
            .then(() => undefined)
            .catch((reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            this.#failTerminal(error);
            throw error;
        });
    }
    ready() {
        return this.#ready;
    }
    async get(namespace, key) {
        await this.#ready;
        return (await this.#request({
            operation: "get",
            namespace,
            key,
        }));
    }
    async list(options) {
        await this.#ready;
        return (await this.#request({
            operation: "list",
            options,
        }));
    }
    put(namespace, key, value, options = {}) {
        return this.batch([{ type: "put", namespace, key, value }], options);
    }
    delete(namespace, key, options = {}) {
        return this.batch([{ type: "delete", namespace, key }], options);
    }
    async batch(mutations, options = {}) {
        await this.#ready;
        return (await this.#request({
            operation: "batch",
            mutations,
            options,
        }));
    }
    async migrate(migration) {
        await this.#ready;
        return (await this.#request({
            operation: "migrate",
            migration,
        }));
    }
    async checkIntegrity() {
        await this.#ready;
        return (await this.#request({
            operation: "integrity-check",
        }));
    }
    async exportBytes() {
        await this.#ready;
        return (await this.#request({ operation: "export" }));
    }
    async stageImport(bytes) {
        await this.#ready;
        return (await this.#request({
            operation: "stage-import",
            bytes,
        }));
    }
    async discardImport(stageId) {
        await this.#ready;
        await this.#request({ operation: "discard-import", stageId });
    }
    async commitImport(stageId, options = {}) {
        await this.#ready;
        return (await this.#request({
            operation: "commit-import",
            stageId,
            options,
        }));
    }
    async reset(options = {}) {
        await this.#ready;
        return (await this.#request({
            operation: "reset",
            options,
        }));
    }
    async runtimeInfo() {
        await this.#ready;
        return (await this.#request({
            operation: "runtime-info",
        }));
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        try {
            await this.#ready;
            await this.#request({ operation: "dispose" }, true);
        }
        finally {
            this.#worker.terminate();
            this.#failAll(new Error("SQLite state store is disposed"));
        }
    }
    #request(request, allowDisposed = false) {
        if (this.#disposed && !allowDisposed) {
            return Promise.reject(new Error("SQLite state store is disposed"));
        }
        if (this.#terminalError !== undefined) {
            return Promise.reject(this.#terminalError);
        }
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ ...request, id });
        });
    }
    #receive(response) {
        const pending = this.#pending.get(response.id);
        if (pending === undefined)
            return;
        this.#pending.delete(response.id);
        if (response.ok) {
            pending.resolve(response.value);
        }
        else {
            pending.reject(reconstructError(response.error));
        }
    }
    #failAll(error) {
        for (const pending of this.#pending.values())
            pending.reject(error);
        this.#pending.clear();
    }
    #failTerminal(error) {
        this.#terminalError = error;
        this.#worker.terminate();
        this.#failAll(error);
    }
}
export async function createSqliteStateStore(options) {
    const store = new SqliteStateStoreClient(options);
    await store.ready();
    return store;
}
function reconstructError(error) {
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
function defaultWorkerFactory() {
    return new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
        name: "edgeproc-sqlite-state",
    });
}
//# sourceMappingURL=client.js.map