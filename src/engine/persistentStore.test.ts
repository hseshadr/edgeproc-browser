import "fake-indexeddb/auto";
import { createStore, set } from "idb-keyval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyEd25519 } from "./crypto.js";
import {
	catalogFetch,
	catalogMetaChunkHash,
	catalogMetaChunkSize,
	chunkBytes,
	latestBytes,
	manifestBytes,
	pubkeyRaw,
} from "./fixtures.js";
import { IndexedDbCacheStore } from "./indexedDbStore.js";
import { IntegrityError } from "./integrity.js";
import { MemoryCacheStore } from "./memoryStore.js";
import {
	openPersistentCacheStore,
	requestPersistentStorage,
} from "./persistentStore.js";
import { StorageQuotaError } from "./storageError.js";
import { syncIndex } from "./sync.js";
import type { CacheStore, VersionPointer } from "./types.js";

let databaseSequence = 0;
let database: string;

const pointer = (sequence: number, hash = "a".repeat(64)): VersionPointer => ({
	manifest_hash: hash,
	version: `v${sequence}`,
	bundle_id: "consumer",
	channel: "stable",
	sequence,
	signature: "signed",
});

beforeEach(() => {
	databaseSequence += 1;
	database = `edgeproc-browser-contract-${databaseSequence}`;
});

function proxyStore(
	delegate: CacheStore,
	overrides: Partial<CacheStore> = {},
): CacheStore {
	return {
		hasChunk: (hash) => delegate.hasChunk(hash),
		putChunkCompressed: (hash, bytes, size) =>
			delegate.putChunkCompressed(hash, bytes, size),
		getChunk: (hash, size) => delegate.getChunk(hash, size),
		putManifest: (bytes) => delegate.putManifest(bytes),
		getManifest: (hash) => delegate.getManifest(hash),
		readActive: () => delegate.readActive(),
		promote: (value) => delegate.promote(value),
		clearActiveIf: (value) => delegate.clearActiveIf(value),
		pruneInactive: () => delegate.pruneInactive(),
		clear: () => delegate.clear(),
		...overrides,
	};
}

describe("persistent cache contract", () => {
	it("falls back to the legacy-compatible IndexedDB identity when OPFS cannot open", async () => {
		const openOpfs = vi
			.fn<() => Promise<CacheStore>>()
			.mockRejectedValue(new DOMException("unavailable", "UnknownError"));
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs,
				openIndexedDb: () => IndexedDbCacheStore.open(database),
			},
		});
		const manifest = new TextEncoder().encode('{"files":[]}');
		const hash = await selected.putManifest(manifest);
		await selected.promote(pointer(7, hash));

		const reopened = await IndexedDbCacheStore.open(database);
		expect(selected.cacheBackend).toBe("indexeddb");
		expect(await reopened.readActive()).toEqual(pointer(7, hash));
		expect(Array.from(await reopened.getManifest(hash))).toEqual(
			Array.from(manifest),
		);
	});

	it("keeps IndexedDB as a rollback floor when OPFS is healthy", async () => {
		const primary = await IndexedDbCacheStore.open(`${database}-primary`);
		const floor = await IndexedDbCacheStore.open(database);
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});
		await selected.promote(pointer(10));

		expect(selected.cacheBackend).toBe("opfs+indexeddb");
		expect(await primary.readActive()).toEqual(pointer(10));
		expect(await floor.readActive()).toEqual(pointer(10));
		await expect(selected.promote(pointer(9))).rejects.toThrow(/refusing/iu);
	});

	it("reuses the warm IndexedDB payload floor when OPFS is empty", async () => {
		const opfs = new MemoryCacheStore();
		const indexedDb = await IndexedDbCacheStore.open(database);
		const fixture = catalogFetch();
		await syncIndex({
			baseUrl: "/cat",
			store: indexedDb,
			fetchBytes: fixture.fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(opfs),
				openIndexedDb: () => Promise.resolve(indexedDb),
			},
		});
		const repeat = catalogFetch();
		const result = await syncIndex({
			baseUrl: "/cat",
			store: selected,
			fetchBytes: repeat.fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});

		expect(selected.cacheBackend).toBe("opfs+indexeddb");
		expect(result.chunksFetched).toBe(0);
		expect(repeat.chunkRequests()).toEqual([]);
	});

	it("selects warm OPFS content when its active pointer is current", async () => {
		const opfs = new MemoryCacheStore();
		const indexedDb = await IndexedDbCacheStore.open(database);
		await syncIndex({
			baseUrl: "/cat",
			store: opfs,
			fetchBytes: catalogFetch().fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(opfs),
				openIndexedDb: () => Promise.resolve(indexedDb),
			},
		});
		const repeat = catalogFetch();
		const result = await syncIndex({
			baseUrl: "/cat",
			store: selected,
			fetchBytes: repeat.fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});

		expect(selected.cacheBackend).toBe("opfs+indexeddb");
		expect(result.chunksFetched).toBe(0);
		expect(repeat.chunkRequests()).toEqual([]);
	});

	it("reuses legacy floor chunks while writing only missing chunks to OPFS", async () => {
		const opfs = new MemoryCacheStore();
		const indexedDb = await IndexedDbCacheStore.open(database);
		await syncIndex({
			baseUrl: "/cat",
			store: indexedDb,
			fetchBytes: catalogFetch().fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(opfs),
				openIndexedDb: () => Promise.resolve(indexedDb),
			},
		});
		const result = await syncIndex({
			baseUrl: "/cat",
			store: selected,
			fetchBytes: catalogFetch().fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
		});
		const active = await selected.readActive();
		if (active === null) throw new Error("active pointer missing");
		const manifest = JSON.parse(
			new TextDecoder().decode(manifestBytes(active.manifest_hash)),
		) as {
			files: ReadonlyArray<{
				path: string;
				chunks: ReadonlyArray<{ hash: string }>;
			}>;
		};
		const newlyFetched = manifest.files
			.find((entry) => entry.path !== "catalog_meta.json")
			?.chunks.at(0)?.hash;
		if (newlyFetched === undefined)
			throw new Error("fixture lacks second file");

		expect(result.chunksReused).toBeGreaterThan(0);
		expect(result.chunksFetched).toBeGreaterThan(0);
		expect(await opfs.hasChunk(newlyFetched)).toBe(true);
		expect(await indexedDb.hasChunk(newlyFetched)).toBe(false);
	});

	it("can explicitly select IndexedDB and treats persistence requests as best effort", async () => {
		const persist = vi.fn(() => Promise.reject(new Error("denied")));
		requestPersistentStorage({ persist });
		await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());

		const openOpfs = vi.fn(() =>
			IndexedDbCacheStore.open(`${database}-unused`),
		);
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs,
				openIndexedDb: () => IndexedDbCacheStore.open(database),
			},
			storageBackend: "indexeddb",
		});
		expect(selected.cacheBackend).toBe("indexeddb");
		expect(openOpfs).not.toHaveBeenCalled();
	});

	it("rejects every equal-sequence pointer disagreement across rollback floors", async () => {
		const primary = await IndexedDbCacheStore.open(`${database}-primary`);
		const floor = await IndexedDbCacheStore.open(database);
		await primary.promote(pointer(10));
		await floor.promote({ ...pointer(10), signature: "other-signature" });
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});

		await expect(selected.readActive()).rejects.toThrow(/floors disagree/iu);
	});

	it("translates legacy quota failures to a stable storage error", async () => {
		const store = await IndexedDbCacheStore.open(database);
		const failure = Object.assign(new Error("legacy quota reached"), {
			name: "NS_ERROR_DOM_QUOTA_REACHED",
		});
		const bytes = new TextEncoder().encode('{"files":[]}');
		const hash = await store.putManifest(bytes);
		const set = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = () => {
			throw failure;
		};
		try {
			await expect(store.putManifest(bytes)).rejects.toBeInstanceOf(
				StorageQuotaError,
			);
		} finally {
			IDBObjectStore.prototype.put = set;
		}
		expect(Array.from(await store.getManifest(hash))).toEqual(
			Array.from(bytes),
		);
	});

	it("does not let a conditional clear delete a concurrently newer promotion", async () => {
		const store = await IndexedDbCacheStore.open(database);
		await store.promote(pointer(1));

		const clearing = store.clearActiveIf(pointer(1));
		const promoting = store.promote(pointer(2));
		expect(await clearing).toBe(true);
		await promoting;
		expect(await store.readActive()).toEqual(pointer(2));
	});

	it("rejects an oversized legacy active record from the stable store identity", async () => {
		const legacy = createStore(database, "content-addressed-cache");
		await set(
			"active",
			{ ...pointer(1), bundle_id: "x".repeat(20_000) },
			legacy,
		);
		const store = await IndexedDbCacheStore.open(database);

		await expect(store.readActive()).resolves.toBeNull();
	});

	it("stores, verifies, self-heals, prunes, and clears IndexedDB content", async () => {
		const store = await IndexedDbCacheStore.open(database);
		const raw = createStore(database, "content-addressed-cache");
		const hash = catalogMetaChunkHash();
		const compressed = chunkBytes(hash);
		const size = catalogMetaChunkSize();
		await store.putChunkCompressed(hash, compressed, size);
		expect(await store.hasChunk(hash)).toBe(true);
		expect((await store.getChunk(hash, size)).byteLength).toBe(size);

		const zeroHash = "0".repeat(64);
		await set(`chunk:${zeroHash}`, new Uint8Array(), raw);
		expect(await store.hasChunk(zeroHash)).toBe(false);
		await expect(store.getChunk(zeroHash, 1)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		await expect(
			store.putChunkCompressed(hash, new Uint8Array(), size),
		).rejects.toThrow(/empty/iu);
		await expect(
			store.putChunkCompressed(hash, new Uint8Array(2 * 1024 * 1024 + 1), size),
		).rejects.toThrow(/read cap/iu);

		await set(`chunk:${hash}`, new Uint8Array([1, 2, 3]), raw);
		await expect(store.getChunk(hash, size)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		expect(await store.hasChunk(hash)).toBe(false);

		const keepHash = catalogMetaChunkHash();
		await store.putChunkCompressed(keepHash, compressed, size);
		const manifestBytes = new TextEncoder().encode(
			JSON.stringify({
				files: [{ chunks: [{ hash: keepHash }] }],
			}),
		);
		const manifestHash = await store.putManifest(manifestBytes);
		expect(Array.from(await store.getManifest(manifestHash))).toEqual(
			Array.from(manifestBytes),
		);
		await expect(store.putManifest(new Uint8Array())).rejects.toThrow(
			/empty/iu,
		);
		await set(`manifest:${manifestHash}`, new Uint8Array([1]), raw);
		await expect(store.getManifest(manifestHash)).rejects.toBeInstanceOf(
			IntegrityError,
		);

		const restoredHash = await store.putManifest(manifestBytes);
		await store.promote(pointer(3, restoredHash));
		const stale = "b".repeat(64);
		await set(`chunk:${stale}`, new Uint8Array([1]), raw);
		await store.pruneInactive();
		expect(await store.hasChunk(keepHash)).toBe(true);
		expect(await store.hasChunk(stale)).toBe(false);
		expect(await store.clearActiveIf(pointer(2, restoredHash))).toBe(false);
		expect(await store.clearActiveIf(pointer(3, restoredHash))).toBe(true);

		await store.clear();
		expect(await store.hasChunk(keepHash)).toBe(false);
		expect(await store.readActive()).toBeNull();
	});

	it("uses OPFS as the sole content store while mirroring only pointer lifecycle", async () => {
		const primary = await IndexedDbCacheStore.open(`${database}-primary`);
		const floor = await IndexedDbCacheStore.open(database);
		const hash = catalogMetaChunkHash();
		const compressed = chunkBytes(hash);
		const size = catalogMetaChunkSize();
		await primary.putChunkCompressed(hash, compressed, size);
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});
		expect(await selected.hasChunk(hash)).toBe(true);
		expect((await selected.getChunk(hash, size)).byteLength).toBe(size);
		expect(await floor.hasChunk(hash)).toBe(false);

		const manifest = new TextEncoder().encode('{"files":[]}');
		const manifestHash = await selected.putManifest(manifest);
		expect(Array.from(await selected.getManifest(manifestHash))).toEqual(
			Array.from(manifest),
		);
		await selected.promote(pointer(8, manifestHash));
		expect((await selected.readActive())?.sequence).toBe(8);
		await expect(
			Promise.resolve().then(() => floor.getManifest(manifestHash)),
		).rejects.toThrow();
		expect(await selected.clearActiveIf(pointer(8, manifestHash))).toBe(true);
		await selected.pruneInactive();
		await selected.clear();
	});

	it("does not duplicate chunk or manifest payloads into the rollback floor", async () => {
		const floor = Object.assign(new MemoryCacheStore(), {
			cacheBackend: "indexeddb" as const,
		});
		const primary = new MemoryCacheStore();
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});

		const hash = catalogMetaChunkHash();
		await selected.putChunkCompressed(
			hash,
			chunkBytes(hash),
			catalogMetaChunkSize(),
		);
		const manifestHash = await selected.putManifest(
			new TextEncoder().encode('{"files":[]}'),
		);

		expect(await primary.hasChunk(hash)).toBe(true);
		expect(await floor.hasChunk(hash)).toBe(false);
		await expect(
			Promise.resolve().then(() => floor.getManifest(manifestHash)),
		).rejects.toThrow();
	});

	it("prunes both stores once and retries a quota-failed mirrored write", async () => {
		const floorDelegate = new MemoryCacheStore();
		const floorPrunes = vi.fn(() => Promise.resolve());
		const floor = Object.assign(
			proxyStore(floorDelegate, { pruneInactive: floorPrunes }),
			{ cacheBackend: "indexeddb" as const },
		);
		const primaryDelegate = new MemoryCacheStore();
		let attempts = 0;
		const primaryPrunes = vi.fn(() => Promise.resolve());
		const primary = proxyStore(primaryDelegate, {
			putChunkCompressed: (hash, bytes, size) => {
				attempts += 1;
				return attempts === 1
					? Promise.reject(new StorageQuotaError())
					: primaryDelegate.putChunkCompressed(hash, bytes, size);
			},
			pruneInactive: primaryPrunes,
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});
		const hash = catalogMetaChunkHash();
		await selected.putChunkCompressed(
			hash,
			chunkBytes(hash),
			catalogMetaChunkSize(),
		);

		expect(attempts).toBe(2);
		expect(floorPrunes).not.toHaveBeenCalled();
		expect(primaryPrunes).toHaveBeenCalledOnce();
	});

	it("fails closed when the durable rollback floor cannot open", async () => {
		const cause = new Error("IndexedDB denied");
		await expect(
			openPersistentCacheStore({
				openers: {
					openOpfs: () => Promise.resolve(new MemoryCacheStore()),
					openIndexedDb: () => Promise.reject(cause),
				},
			}),
		).rejects.toMatchObject({ cause });
	});

	it("reuses and clears a validated legacy slash-key IndexedDB layout in place", async () => {
		const legacyDatabase = `${database}-legacy`;
		const raw = createStore(legacyDatabase, "entries");
		const active = JSON.parse(
			new TextDecoder().decode(latestBytes()),
		) as VersionPointer;
		const rawManifest = manifestBytes(active.manifest_hash);
		const manifest = JSON.parse(new TextDecoder().decode(rawManifest)) as {
			files: ReadonlyArray<{
				path: string;
				chunks: ReadonlyArray<{ hash: string }>;
			}>;
		};
		const selected = manifest.files.find(
			(entry) => entry.path === "catalog_meta.json",
		);
		if (selected === undefined)
			throw new Error("catalog fixture missing metadata");
		await set("active", active, raw);
		await set(`manifest/${active.manifest_hash}`, rawManifest, raw);
		for (const chunk of selected.chunks) {
			await set(`chunk/${chunk.hash}`, chunkBytes(chunk.hash), raw);
		}
		const store = await IndexedDbCacheStore.open({
			database: legacyDatabase,
			store: "entries",
			separator: "/",
		});
		const fixture = catalogFetch();
		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: fixture.fetchBytes,
			verify: (message, signature) =>
				verifyEd25519(pubkeyRaw(), message, signature),
			wantedPaths: ["catalog_meta.json"],
		});

		expect(result.chunksFetched).toBe(0);
		expect(fixture.chunkRequests()).toEqual([]);
		await store.clear();
		expect(await store.readActive()).toBeNull();
		expect(await store.hasChunk(selected.chunks[0]?.hash ?? "missing")).toBe(
			false,
		);
	});
});
