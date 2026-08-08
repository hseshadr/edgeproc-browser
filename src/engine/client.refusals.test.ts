// Every FAILURE path of the main-thread Worker client.
//
// The whole reason this class exists is that a Worker which dies during init
// never posts a reply. Without typed failures the caller's promise hangs
// forever — no error, no timeout, no boot. Those are the branches below, and
// they are the ones a happy-path suite cannot reach: crash, latched crash,
// deadline, dispose, and a reply that arrives for a request nobody is awaiting.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineClient, type EngineWorkerLike } from "./client.js";
import type { EngineRequest, EngineResponse } from "./protocol.js";
import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	WorkerCrashError,
	WorkerTimeoutError,
} from "./workerFault.js";

/** A Worker stand-in whose events this test drives by hand. */
function fakeWorker() {
	const listeners = {
		message: [] as ((event: MessageEvent<EngineResponse>) => void)[],
		error: [] as ((event: { message: string }) => void)[],
		messageerror: [] as (() => void)[],
	};
	const sent: EngineRequest[] = [];
	const terminate = vi.fn();
	const worker: EngineWorkerLike = {
		postMessage: (message) => {
			sent.push(message);
		},
		// biome-ignore lint/suspicious/noExplicitAny: the overloaded listener map
		addEventListener: (type: any, listener: any) => {
			listeners[type as keyof typeof listeners].push(listener);
		},
		terminate,
	};
	return {
		worker,
		sent,
		terminate,
		reply: (response: EngineResponse) => {
			for (const l of listeners.message) {
				l({ data: response } as MessageEvent<EngineResponse>);
			}
		},
		crash: (message: string) => {
			for (const l of listeners.error) l({ message });
		},
		messageerror: () => {
			for (const l of listeners.messageerror) l();
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a Worker that dies never leaves a caller hanging", () => {
	it("rejects the in-flight request with WorkerCrashError on 'error'", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.crash("script load failed");
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WorkerCrashError);
		expect((error as Error).message).toContain("script load failed");
	});

	it("rejects on 'messageerror' too — an undeserializable reply is a crash", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("catalog_meta.json");
		fake.messageerror();
		await expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
	});

	it("LATCHES: once crashed, later requests fail fast instead of hanging", async () => {
		// A dead Worker never revives. Sending to it would produce exactly the
		// forever-pending promise this class exists to prevent.
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		fake.crash("boom");
		await expect(client.readFile("a")).rejects.toBeInstanceOf(WorkerCrashError);
		await expect(
			client.sync("https://cdn.example", "/public.key"),
		).rejects.toBeInstanceOf(WorkerCrashError);
		// Nothing was ever posted to the dead worker.
		expect(fake.sent).toHaveLength(0);
	});

	it("keeps the FIRST crash reason — later noise does not overwrite it", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		fake.crash("the real cause");
		fake.crash("a later, less useful message");
		const error = await client.readFile("a").catch((e: unknown) => e);
		expect((error as Error).message).toContain("the real cause");
	});

	// EVERY caller, not just the one that happened to be first in the map — and
	// the Worker itself is released. An 'error' event is an uncaught throw
	// INSIDE the Worker, not proof the Worker died: left alone it keeps running,
	// still holding its OPFS sync access handle, and nothing will ever ask it
	// for anything again. Rejecting the promises without terminating swaps a
	// hung caller for a leaked thread.
	it("rejects EVERY pending call and releases the Worker on a crash", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const first = client.readFile("a");
		const second = client.sync("https://cdn.example", "/public.key");

		fake.crash("fatal boot");

		await expect(first).rejects.toThrow("fatal boot");
		await expect(second).rejects.toThrow("fatal boot");
		expect(fake.terminate).toHaveBeenCalledOnce();
	});
});

describe("a Worker that goes silent is bounded by a deadline", () => {
	it("rejects with WorkerTimeoutError once the deadline passes", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		await vi.advanceTimersByTimeAsync(51);
		await assertion;
	});

	it("defaults to a 60s response deadline", () => {
		// Pinned to the literal the docs promise, not to the constant itself.
		expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(60_000);
	});

	// A deadline that only settles the CALLER's promise bounds nothing. The
	// Worker is still running whatever went silent, still holding its handle,
	// and the next request would be posted into the same silence. Terminating
	// on the deadline is what makes the bound real rather than cosmetic.
	it("terminates the silent Worker when the deadline fires", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		await vi.advanceTimersByTimeAsync(51);
		await assertion;

		expect(fake.terminate).toHaveBeenCalledOnce();
		// And it latches: a request after the deadline must not be posted into
		// the Worker that was just released.
		await expect(client.readFile("b")).rejects.toBeInstanceOf(WorkerCrashError);
		expect(fake.sent).toHaveLength(1);
	});

	it("does not fire the deadline for a request that already answered", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const id = fake.sent[0]?.id ?? 0;
		fake.reply({
			ok: true,
			kind: "readFile",
			id,
			bytes: Uint8Array.from([7]),
		} as EngineResponse);
		await expect(pending).resolves.toEqual(Uint8Array.from([7]));
		// If the timer had survived the reply it would reject an already-settled
		// promise here; an unhandled rejection would surface.
		await vi.advanceTimersByTimeAsync(500);
	});
});

describe("replies are correlated, not trusted", () => {
	it("ignores a reply whose id nobody is awaiting", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("a");
		const realId = fake.sent[0]?.id ?? 0;
		// A stray/duplicate reply must not resolve the wrong promise.
		fake.reply({
			ok: true,
			kind: "readFile",
			id: realId + 999,
			bytes: Uint8Array.from([1]),
		} as EngineResponse);
		fake.reply({
			ok: true,
			kind: "readFile",
			id: realId,
			bytes: Uint8Array.from([2]),
		} as EngineResponse);
		await expect(pending).resolves.toEqual(Uint8Array.from([2]));
	});

	it("rejects when the Worker answers with an error envelope", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.reply({
			ok: false,
			kind: "sync",
			id: fake.sent[0]?.id ?? 0,
			error: "signature verification failed",
		} as EngineResponse);
		await expect(pending).rejects.toThrow("signature verification failed");
	});

	it("rejects a well-formed reply of the WRONG kind", async () => {
		// ok:true is not enough — a readFile answer to a sync request is a bug,
		// and returning it would hand the caller the wrong bytes.
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.reply({
			ok: true,
			kind: "readFile",
			id: fake.sent[0]?.id ?? 0,
			bytes: Uint8Array.from([1]),
		} as EngineResponse);
		await expect(pending).rejects.toThrow("unexpected response kind");
	});

	it("gives every request a distinct id", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		// Swallow: dispose() below rejects these by design; the ids are the subject.
		client.readFile("a").catch(() => {});
		client.readFile("b").catch(() => {});
		const ids = fake.sent.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		client.dispose();
	});
});

describe("dispose", () => {
	it("terminates the Worker and rejects everything in flight", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("a");
		client.dispose();
		await expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
		expect(fake.terminate).toHaveBeenCalledOnce();
	});

	it("is idempotent — a second call does not terminate twice", () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.dispose();
		client.dispose();
		expect(fake.terminate).toHaveBeenCalledOnce();
	});

	it("terminate() is the alias, and shares the same latch", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.terminate();
		expect(fake.terminate).toHaveBeenCalledOnce();
		await expect(client.readFile("a")).rejects.toBeInstanceOf(WorkerCrashError);
	});
});

describe("sync pins a bundle identity by default", () => {
	it("sends the caller's expected bundle id and channel", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client
			.sync("https://cdn.example", "/public.key", "my-bundle", "beta")
			.catch(() => {});
		expect(fake.sent[0]).toMatchObject({
			kind: "sync",
			expectedBundleId: "my-bundle",
			expectedChannel: "beta",
		});
		client.dispose();
	});

	it("always sends BOTH pins even when the caller omits them", async () => {
		// The Worker refuses an unpinned sync, so an omitted pin must become a
		// concrete value here rather than travelling as undefined.
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.sync("https://cdn.example", "/public.key").catch(() => {});
		const sent = fake.sent[0] as unknown as Record<string, unknown>;
		expect(typeof sent.expectedBundleId).toBe("string");
		expect(typeof sent.expectedChannel).toBe("string");
		expect(sent.expectedBundleId).not.toBe("");
		expect(sent.expectedChannel).not.toBe("");
		client.dispose();
	});
});
