import { describe, expect, it } from "vitest";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { verifyEd25519 } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { catalogFetch, latestBytes, pubkeyRaw } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { materializeFile, syncIndex } from "./sync.js";
import type {
	FetchBytes,
	IndexManifest,
	Verify,
	VersionPointer,
} from "./types.js";

const DECODER = new TextDecoder();
const PUBKEY = pubkeyRaw();

const realVerify: Verify = (message, signature) =>
	verifyEd25519(PUBKEY, message, signature);

function realPointer(): VersionPointer {
	return JSON.parse(DECODER.decode(latestBytes())) as VersionPointer;
}

async function loadManifest(
	store: MemoryCacheStore,
	hash: string,
): Promise<IndexManifest> {
	return JSON.parse(
		DECODER.decode(await store.getManifest(hash)),
	) as IndexManifest;
}

describe("syncIndex against the real examples/catalog bundle", () => {
	it("first run fetches every chunk, reuses none, and reassembles files byte-correct", async () => {
		const store = new MemoryCacheStore();
		const { fetchBytes } = catalogFetch();

		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes,
			verify: realVerify,
		});

		expect(result.version).toBe("v1");
		expect(result.chunksReused).toBe(0);
		expect(result.chunksFetched).toBeGreaterThan(0);
		expect(result.bytesFetched).toBeGreaterThan(0);

		// promoted pointer matches the signed pointer
		const active = await store.readActive();
		expect(active?.manifest_hash).toBe(result.manifestHash);

		// every file reassembles + passes its file_sha256 check
		const manifest = await loadManifest(store, result.manifestHash);
		for (const entry of manifest.files) {
			const bytes = await materializeFile(store, manifest, entry.path);
			expect(bytes.byteLength).toBe(entry.size);
		}
	});

	it("re-run against a primed store fetches nothing (chunksFetched == 0)", async () => {
		const store = new MemoryCacheStore();
		const first = catalogFetch();
		await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: first.fetchBytes,
			verify: realVerify,
		});

		const second = catalogFetch();
		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: second.fetchBytes,
			verify: realVerify,
		});

		expect(result.chunksFetched).toBe(0);
		expect(result.bytesFetched).toBe(0);
		expect(result.chunksReused).toBeGreaterThan(0);
		expect(second.chunkRequests()).toHaveLength(0);
	});

	it("materializeFile returns catalog_meta.json as valid JSON", async () => {
		const store = new MemoryCacheStore();
		const { fetchBytes } = catalogFetch();
		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes,
			verify: realVerify,
		});
		const manifest = await loadManifest(store, result.manifestHash);

		const bytes = await materializeFile(store, manifest, "catalog_meta.json");
		const meta = JSON.parse(DECODER.decode(bytes)) as Record<string, unknown>;
		expect(typeof meta).toBe("object");
	});
});

describe("syncIndex fail-closed behavior", () => {
	it("rejects a tampered pointer signature and promotes nothing", async () => {
		const store = new MemoryCacheStore();
		const pointer = realPointer();
		const tampered: VersionPointer = {
			...pointer,
			signature:
				(pointer.signature[0] === "A" ? "B" : "A") + pointer.signature.slice(1),
		};
		const fetchBytes = (url: string): Promise<Uint8Array> => {
			if (url.endsWith("/latest")) {
				return Promise.resolve(
					new TextEncoder().encode(JSON.stringify(tampered)),
				);
			}
			return Promise.reject(
				new Error(`should not fetch ${url} after a bad pointer`),
			);
		};

		await expect(
			syncIndex({ baseUrl: "/cat", store, fetchBytes, verify: realVerify }),
		).rejects.toThrow();
		expect(await store.readActive()).toBeNull();
	});

	it("rejects a manifest whose bytes do not hash to the pointer (content-address)", async () => {
		const store = new MemoryCacheStore();
		const pointer = realPointer();
		// keep the signature valid but serve a different manifest body
		const fetchBytes = (url: string): Promise<Uint8Array> => {
			if (url.endsWith("/latest")) {
				return Promise.resolve(latestBytes());
			}
			if (url.includes("/manifest/")) {
				return Promise.resolve(new TextEncoder().encode('{"tampered":true}'));
			}
			return Promise.reject(new Error(`unexpected ${url}`));
		};
		const verify: Verify = (message) => {
			// accept the real pointer message so we exercise the manifest check
			void message;
			return Promise.resolve();
		};
		void pointer;

		await expect(
			syncIndex({ baseUrl: "/cat", store, fetchBytes, verify }),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(await store.readActive()).toBeNull();
	});

	it("a real pointer's canonical message verifies (parity guard inside sync)", async () => {
		const pointer = realPointer();
		const message = canonicalBytes(pointer as unknown as JsonValue, {
			exclude: { signature: true },
		});
		await expect(
			realVerify(message, pointer.signature),
		).resolves.toBeUndefined();
	});
});

describe("syncIndex offline fallback to the cached active version", () => {
	/** Prime a store with a fully-synced active version (online first run). */
	async function primedStore(): Promise<MemoryCacheStore> {
		const store = new MemoryCacheStore();
		const { fetchBytes } = catalogFetch();
		await syncIndex({ baseUrl: "/cat", store, fetchBytes, verify: realVerify });
		return store;
	}

	it("serves the cached version (0 fetched) when /latest is network-unreachable", async () => {
		const store = await primedStore();
		const active = await store.readActive();

		// A transport that is offline for the pointer fetch.
		const offlineFetch: FetchBytes = (url) => {
			if (url.endsWith("/latest")) {
				return Promise.reject(new NetworkError(`offline: ${url}`));
			}
			return Promise.reject(new Error(`should not fetch ${url} while offline`));
		};

		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: offlineFetch,
			verify: realVerify,
		});

		expect(result.version).toBe(active?.version);
		expect(result.manifestHash).toBe(active?.manifest_hash);
		expect(result.chunksFetched).toBe(0);
		expect(result.bytesFetched).toBe(0);
		expect(result.chunksReused).toBeGreaterThan(0);
		// the cached active version is still readable + reassembles byte-correct
		const manifest = await loadManifest(store, result.manifestHash);
		for (const entry of manifest.files) {
			const bytes = await materializeFile(store, manifest, entry.path);
			expect(bytes.byteLength).toBe(entry.size);
		}
	});

	// The cache is not a trusted tier. Offline is precisely when nothing else
	// is checking the pointer, and the adversary in a local-first system HOLDS
	// the machine — so the cached pointer's signature is re-verified on the way
	// out, not assumed valid because it was valid when it was written. A failed
	// re-verification also must not evict or rewrite what is there: refusing to
	// serve is the answer, not destroying the state and re-syncing blind.
	it("re-verifies the CACHED pointer's signature before serving it offline", async () => {
		const store = await primedStore();
		const before = await store.readActive();
		const rejectsCached: Verify = () =>
			Promise.reject(new Error("cached pointer signature rejected"));

		await expect(
			syncIndex({
				baseUrl: "/cat",
				store,
				fetchBytes: () => Promise.reject(new NetworkError("offline")),
				verify: rejectsCached,
			}),
		).rejects.toThrow("cached pointer signature rejected");
		expect((await store.readActive())?.manifest_hash).toBe(
			before?.manifest_hash,
		);
	});

	it("re-throws when offline AND no active version is cached (cold + offline)", async () => {
		const store = new MemoryCacheStore();
		const offlineFetch: FetchBytes = (url) =>
			Promise.reject(new NetworkError(`offline: ${url}`));

		await expect(
			syncIndex({
				baseUrl: "/cat",
				store,
				fetchBytes: offlineFetch,
				verify: realVerify,
			}),
		).rejects.toBeInstanceOf(NetworkError);
		expect(await store.readActive()).toBeNull();
	});

	it("does NOT fall back on a signature failure even with a cached version (fail-closed)", async () => {
		const store = await primedStore();
		const before = await store.readActive();

		// /latest is reachable but tampered; verify rejects (not a NetworkError).
		const pointer = realPointer();
		const tampered: VersionPointer = {
			...pointer,
			signature:
				(pointer.signature[0] === "A" ? "B" : "A") + pointer.signature.slice(1),
		};
		const fetchBytes: FetchBytes = (url) => {
			if (url.endsWith("/latest")) {
				return Promise.resolve(
					new TextEncoder().encode(JSON.stringify(tampered)),
				);
			}
			return Promise.reject(new Error(`unexpected ${url}`));
		};

		await expect(
			syncIndex({ baseUrl: "/cat", store, fetchBytes, verify: realVerify }),
		).rejects.toThrow();
		// the previously-promoted active version is untouched (no silent rollback)
		expect((await store.readActive())?.manifest_hash).toBe(
			before?.manifest_hash,
		);
	});
});
