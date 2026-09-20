// OpfsCacheStore self-heal: a content-address failure on read must EVICT the bad
// object, not fail-closed forever. Without eviction one corrupt chunk (a partial
// write / bit-rot) poisons every subsequent load — hasChunk stays true, so the
// sync loop never re-fetches it and the engine can never recover. These specs
// drive the real store over a tiny in-memory OPFS fake (createSyncAccessHandle
// is Worker-only, so there is no real OPFS under Vitest's node environment).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	catalogMetaChunkHash,
	catalogMetaChunkSize,
	chunkBytes,
} from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import {
	canPromotePointer,
	OpfsCacheStore,
	selectHighestPointer,
} from "./opfsStore.js";
import type { VersionPointer } from "./types.js";

// A real catalog chunk hash + its verbatim zstd bytes (plaintext sha256 == name).
const REAL_CHUNK = catalogMetaChunkHash();
const REAL_CHUNK_SIZE = catalogMetaChunkSize();

/** One OPFS file as a growable byte buffer; the sync access handle reads/writes it. */
class FakeFile {
	public bytes = new Uint8Array();
	public handleFailure: Error | undefined;
	public createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
		if (this.handleFailure !== undefined) {
			return Promise.reject(this.handleFailure);
		}
		return Promise.resolve(
			new FakeSyncHandle(this) as unknown as FileSystemSyncAccessHandle,
		);
	}
}

/** The Worker-only sync access handle surface OpfsCacheStore actually calls. */
class FakeSyncHandle {
	readonly #file: FakeFile;
	public constructor(file: FakeFile) {
		this.#file = file;
	}
	public getSize(): number {
		return this.#file.bytes.length;
	}
	public read(buffer: Uint8Array, opts: { at: number }): number {
		const slice = this.#file.bytes.subarray(opts.at, opts.at + buffer.length);
		buffer.set(slice);
		return slice.length;
	}
	public write(data: Uint8Array, opts: { at: number }): number {
		const end = opts.at + data.length;
		if (end > this.#file.bytes.length) {
			const grown = new Uint8Array(end);
			grown.set(this.#file.bytes);
			this.#file.bytes = grown;
		}
		this.#file.bytes.set(data, opts.at);
		return data.length;
	}
	public truncate(size: number): void {
		this.#file.bytes = this.#file.bytes.slice(0, size);
	}
	public flush(): void {}
	public close(): void {}
}

/** A minimal in-memory OPFS directory: files by name, child dirs, removeEntry. */
class FakeDir {
	public readonly files = new Map<string, FakeFile>();
	public readonly dirs = new Map<string, FakeDir>();
	public getDirectoryHandle(
		name: string,
		opts?: { create?: boolean },
	): Promise<FakeDir> {
		let dir = this.dirs.get(name);
		if (dir === undefined) {
			if (opts?.create !== true) {
				return Promise.reject(new DOMException(name, "NotFoundError"));
			}
			dir = new FakeDir();
			this.dirs.set(name, dir);
		}
		return Promise.resolve(dir);
	}
	public getFileHandle(
		name: string,
		opts?: { create?: boolean },
	): Promise<FakeFile> {
		let file = this.files.get(name);
		if (file === undefined) {
			if (opts?.create !== true) {
				return Promise.reject(new DOMException(name, "NotFoundError"));
			}
			file = new FakeFile();
			this.files.set(name, file);
		}
		return Promise.resolve(file);
	}
	public removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name)) {
			return Promise.reject(new DOMException(name, "NotFoundError"));
		}
		return Promise.resolve();
	}
	public async *entries(): AsyncGenerator<[string, FakeFile]> {
		for (const entry of this.files) yield entry;
	}
}

/** Point navigator.storage.getDirectory at a fresh fake OPFS root; return the root. */
function stubOpfs(): FakeDir {
	const root = new FakeDir();
	vi.stubGlobal("navigator", {
		storage: { getDirectory: (): Promise<FakeDir> => Promise.resolve(root) },
	} as unknown as Navigator);
	return root;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpfsCacheStore self-heal on a corrupt chunk", () => {
	it("evicts a corrupted chunk so the next sync re-fetches it (no permanent poison)", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();

		await store.putChunkCompressed(
			REAL_CHUNK,
			chunkBytes(REAL_CHUNK),
			REAL_CHUNK_SIZE,
		);
		expect(await store.hasChunk(REAL_CHUNK)).toBe(true);
		expect(
			(await store.getChunk(REAL_CHUNK, REAL_CHUNK_SIZE)).byteLength,
		).toBeGreaterThan(0);

		// Poison the stored bytes on disk (a partial write / bit-rot corrupts the
		// content-addressed object so its plaintext no longer hashes to its name).
		const chunkFile = root.dirs.get("chunk")?.files.get(REAL_CHUNK);
		if (chunkFile === undefined) {
			throw new Error("chunk file missing from fake OPFS");
		}
		chunkFile.bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);

		// Fail-closed read AND self-heal: the read still rejects, but the bad entry
		// is evicted so hasChunk goes false — the sync loop will re-fetch it.
		await expect(
			store.getChunk(REAL_CHUNK, REAL_CHUNK_SIZE),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(await store.hasChunk(REAL_CHUNK)).toBe(false);

		// Re-sync lands the good chunk again and loads recover — no permanent poison.
		await store.putChunkCompressed(
			REAL_CHUNK,
			chunkBytes(REAL_CHUNK),
			REAL_CHUNK_SIZE,
		);
		expect(
			(await store.getChunk(REAL_CHUNK, REAL_CHUNK_SIZE)).byteLength,
		).toBeGreaterThan(0);
	});

	it("leaves a healthy chunk in place across repeated reads (no spurious eviction)", async () => {
		stubOpfs();
		const store = await OpfsCacheStore.open();
		await store.putChunkCompressed(
			REAL_CHUNK,
			chunkBytes(REAL_CHUNK),
			REAL_CHUNK_SIZE,
		);

		await store.getChunk(REAL_CHUNK, REAL_CHUNK_SIZE);
		await store.getChunk(REAL_CHUNK, REAL_CHUNK_SIZE);

		expect(await store.hasChunk(REAL_CHUNK)).toBe(true);
	});

	it("treats a zero-byte object as absent and removes it", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const chunkDir = root.dirs.get("chunk");
		if (chunkDir === undefined) throw new Error("chunk directory missing");
		chunkDir.files.set(REAL_CHUNK, new FakeFile());

		expect(await store.hasChunk(REAL_CHUNK)).toBe(false);
		expect(chunkDir.files.has(REAL_CHUNK)).toBe(false);
	});

	it("preserves a valid existing object when handle contention prevents a write", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const manifest = new TextEncoder().encode(
			'{"schema_version":2,"files":[]}',
		);
		const hash = await store.putManifest(manifest);
		const file = root.dirs.get("manifest")?.files.get(hash);
		if (file === undefined) throw new Error("manifest file missing");
		file.handleFailure = new DOMException("busy", "NoModificationAllowedError");

		await expect(store.putManifest(manifest)).rejects.toThrow(/busy/iu);
		expect(root.dirs.get("manifest")?.files.has(hash)).toBe(true);
		file.handleFailure = undefined;
		expect(Array.from(await store.getManifest(hash))).toEqual(
			Array.from(manifest),
		);
	});
});

const pointer = (
	sequence: number,
	manifestHash = "a".repeat(64),
): VersionPointer => ({
	manifest_hash: manifestHash,
	version: `v${sequence}`,
	bundle_id: "bundle",
	channel: "stable",
	sequence,
	signature: "signed",
});

describe("durable OPFS active pointer selection", () => {
	it("keeps the newest valid slot when another slot is torn", () => {
		expect(selectHighestPointer([pointer(4), null, pointer(3)])?.sequence).toBe(
			4,
		);
	});

	it("rejects stale and equal-sequence equivocation during promotion", () => {
		const current = pointer(7);
		expect(canPromotePointer(current, pointer(6))).toBe(false);
		expect(canPromotePointer(current, pointer(7, "b".repeat(64)))).toBe(false);
		expect(
			canPromotePointer(current, { ...pointer(7), signature: "different" }),
		).toBe(false);
		expect(canPromotePointer(current, pointer(8))).toBe(true);
	});

	it("rejects equal-sequence disagreement across durable slots", () => {
		expect(() =>
			selectHighestPointer([
				pointer(7),
				{ ...pointer(7), signature: "different-signature" },
			]),
		).toThrow(/disagree/iu);
	});

	it("includes the legacy active pointer in the promotion floor", async () => {
		const root = stubOpfs();
		const legacy = new FakeFile();
		legacy.bytes = new TextEncoder().encode(JSON.stringify(pointer(7)));
		root.files.set("active", legacy);
		const store = await OpfsCacheStore.open();

		await expect(store.promote(pointer(6))).rejects.toThrow(/refusing/iu);
		expect((await store.readActive())?.sequence).toBe(7);
	});
});
