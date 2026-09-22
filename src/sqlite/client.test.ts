import { describe, expect, it } from "vitest";
import { SqliteStateStoreClient } from "./client";
import { SqliteStateConflictError, SqliteStateSchemaError } from "./database";
import type {
	SqliteStateWorkerRequest,
	SqliteStateWorkerResponse,
} from "./protocol";

class FakeWorker {
	readonly requests: SqliteStateWorkerRequest[] = [];
	terminated = false;
	readonly refusal:
		| { readonly name: string; readonly message: string }
		| undefined;
	readonly #messages: Array<
		(event: MessageEvent<SqliteStateWorkerResponse>) => void
	> = [];
	readonly #errors: Array<(event: ErrorEvent) => void> = [];
	readonly #messageErrors: Array<(event: MessageEvent<unknown>) => void> = [];

	public constructor(refusal?: {
		readonly name: string;
		readonly message: string;
	}) {
		this.refusal = refusal;
	}

	public postMessage(request: SqliteStateWorkerRequest): void {
		this.requests.push(request);
		queueMicrotask(() => {
			if (this.refusal === undefined) {
				this.#respond(request.id, valueFor(request));
			} else {
				this.#respondFailure(request.id, this.refusal);
			}
		});
	}

	public addEventListener(
		type: "message" | "error" | "messageerror",
		listener:
			| ((event: MessageEvent<SqliteStateWorkerResponse>) => void)
			| ((event: ErrorEvent) => void)
			| ((event: MessageEvent<unknown>) => void),
	): void {
		if (type === "message") {
			this.#messages.push(
				listener as (event: MessageEvent<SqliteStateWorkerResponse>) => void,
			);
		} else if (type === "error") {
			this.#errors.push(listener as (event: ErrorEvent) => void);
		} else {
			this.#messageErrors.push(
				listener as (event: MessageEvent<unknown>) => void,
			);
		}
	}

	public terminate(): void {
		this.terminated = true;
	}

	public fail(message: string): void {
		for (const listener of this.#errors) {
			listener(new ErrorEvent("error", { message }));
		}
	}

	public failMessage(): void {
		for (const listener of this.#messageErrors) {
			listener(new MessageEvent("messageerror"));
		}
	}

	#respond(id: number, value: unknown): void {
		for (const listener of this.#messages) {
			listener(new MessageEvent("message", { data: { id, ok: true, value } }));
		}
	}

	#respondFailure(
		id: number,
		error: { readonly name: string; readonly message: string },
	): void {
		for (const listener of this.#messages) {
			listener(new MessageEvent("message", { data: { id, ok: false, error } }));
		}
	}
}

function valueFor(request: SqliteStateWorkerRequest): unknown {
	switch (request.operation) {
		case "get":
			return {
				namespace: request.namespace,
				key: request.key,
				value: new Uint8Array([1]),
				revision: 2,
			};
		case "list":
			return { rows: [], nextKey: undefined };
		case "batch":
		case "reset":
			return { changed: 1, epoch: 2 };
		case "migrate":
			return {
				changed: 1,
				epoch: 3,
				schemaVersion: request.migration.toVersion,
			};
		case "integrity-check":
			return { ok: true, message: "ok" };
		case "export":
			return new Uint8Array([1, 2, 3]);
		case "stage-import":
			return {
				stageId: "stage-1",
				schemaVersion: 2,
				epoch: 1,
				rowCount: 1,
				byteLength: request.bytes.byteLength,
			};
		case "commit-import":
			return { changed: 2, epoch: 3, schemaVersion: 2 };
		case "runtime-info":
			return {
				name: "client",
				sqliteVersion: "3.53.4",
				persistence: "memory",
				ownership: "isolated-worker",
				schemaVersion: 1,
				epoch: 2,
				rowCount: 1,
			};
		default:
			return undefined;
	}
}

describe("SqliteStateStoreClient", () => {
	it("proxies the complete typed API without an arbitrary SQL operation", async () => {
		const worker = new FakeWorker();
		const store = new SqliteStateStoreClient(
			{ name: "client", initialSchemaVersion: 1, persistence: "memory" },
			() => worker,
		);
		await store.ready();
		expect((await store.get("scope", "key"))?.revision).toBe(2);
		expect((await store.list({ namespace: "scope" })).rows).toEqual([]);
		await store.put("scope", "key", new Uint8Array([2]), {
			expectedEpoch: 1,
		});
		await store.delete("scope", "key");
		await store.batch([]);
		expect(
			await store.migrate({
				fromVersion: 1,
				toVersion: 2,
				mutations: [],
			}),
		).toMatchObject({ schemaVersion: 2 });
		expect(await store.checkIntegrity()).toEqual({ ok: true, message: "ok" });
		expect(await store.exportBytes()).toEqual(new Uint8Array([1, 2, 3]));
		const stage = await store.stageImport(new Uint8Array([4]));
		await store.discardImport(stage.stageId);
		await store.commitImport(stage.stageId);
		await store.reset();
		expect((await store.runtimeInfo()).sqliteVersion).toBe("3.53.4");
		expect(worker.requests.some((request) => "sql" in request)).toBe(false);
		await store.dispose();
		await store.dispose();
		expect(worker.terminated).toBe(true);
		await expect(store.get("scope", "key")).rejects.toThrow(/disposed/);
	});

	it("reconstructs public conflict and schema error classes", async () => {
		const conflictWorker = new FakeWorker({
			name: "SqliteStateConflictError",
			message: "stale",
		});
		const conflict = new SqliteStateStoreClient(
			{ name: "conflict", initialSchemaVersion: 1 },
			() => conflictWorker,
		);
		await expect(conflict.ready()).rejects.toBeInstanceOf(
			SqliteStateConflictError,
		);

		const schemaWorker = new FakeWorker({
			name: "SqliteStateSchemaError",
			message: "wrong schema",
		});
		const schema = new SqliteStateStoreClient(
			{ name: "schema", initialSchemaVersion: 1 },
			() => schemaWorker,
		);
		await expect(schema.ready()).rejects.toBeInstanceOf(SqliteStateSchemaError);
	});

	it("treats Worker crashes and unreadable messages as terminal", async () => {
		const crashedWorker = new FakeWorker();
		const crashed = new SqliteStateStoreClient(
			{ name: "crashed", initialSchemaVersion: 1 },
			() => crashedWorker,
		);
		await crashed.ready();
		crashedWorker.fail("boom");
		await expect(crashed.runtimeInfo()).rejects.toThrow(/worker failed: boom/);
		expect(crashedWorker.terminated).toBe(true);

		const unreadableWorker = new FakeWorker();
		const unreadable = new SqliteStateStoreClient(
			{ name: "unreadable", initialSchemaVersion: 1 },
			() => unreadableWorker,
		);
		await unreadable.ready();
		unreadableWorker.failMessage();
		await expect(unreadable.runtimeInfo()).rejects.toThrow(
			/unreadable message/,
		);
	});
});
