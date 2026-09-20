import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnEngineClient } from "./spawn.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("spawnEngineClient", () => {
	it("spawns the packaged module Worker only when the opt-in helper is called", () => {
		const constructed = vi.fn();
		const terminate = vi.fn();
		class FakeWorker {
			public constructor(url: URL, options: WorkerOptions) {
				constructed(url, options);
			}

			public postMessage(): void {}
			public addEventListener(): void {}
			public terminate(): void {
				terminate();
			}
		}
		vi.stubGlobal("Worker", FakeWorker);

		const client = spawnEngineClient({ idleTimeoutMs: 1_000 });
		expect(constructed).toHaveBeenCalledOnce();
		const [url, options] = constructed.mock.calls[0] as [URL, WorkerOptions];
		// Vitest resolves the source specifier to worker.ts; the dist contract
		// separately proves the published helper retains ./worker.js.
		expect(url.pathname).toMatch(/\/engine\/worker\.(?:ts|js)$/);
		expect(options).toEqual({ type: "module" });

		client.dispose();
		expect(terminate).toHaveBeenCalledOnce();
	});
});
