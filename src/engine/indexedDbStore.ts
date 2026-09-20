import {
	clear,
	createStore,
	del,
	delMany,
	get,
	keys,
	promisifyRequest,
	set,
	type UseStore,
	update,
} from "idb-keyval";
import { parseStoredPointer, samePointer } from "./activePointer.js";
import { cacheDatabaseName } from "./cacheLock.js";
import { sha256Hex } from "./crypto.js";
import { decompressAndVerify, IntegrityError } from "./integrity.js";
import { canPromotePointer } from "./opfsStore.js";
import { translateStorageError } from "./storageError.js";
import type { CacheStore, VersionPointer } from "./types.js";

const STORE = "content-addressed-cache";
const ACTIVE = "active";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPRESSED_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface IndexedDbLayout {
	readonly database: string;
	readonly store: string;
	readonly separator: ":" | "/";
}

export type IndexedDbLayoutOptions = Partial<IndexedDbLayout>;

export function resolveIndexedDbLayout(
	options: IndexedDbLayoutOptions = {},
	defaultDatabase = cacheDatabaseName(),
): IndexedDbLayout {
	const database = validatedName(
		options.database ?? defaultDatabase,
		"database",
	);
	const store = validatedName(options.store ?? STORE, "object store");
	const separator = options.separator ?? ":";
	if (separator !== ":" && separator !== "/") {
		throw new TypeError("IndexedDB key separator must be ':' or '/'");
	}
	return { database, store, separator };
}

export class IndexedDbCacheStore implements CacheStore {
	public readonly cacheBackend = "indexeddb" as const;
	readonly #store: UseStore;
	readonly #separator: IndexedDbLayout["separator"];

	private constructor(
		store: UseStore,
		separator: IndexedDbLayout["separator"],
	) {
		this.#store = store;
		this.#separator = separator;
	}

	public static async open(
		options: IndexedDbLayoutOptions | string = {},
	): Promise<IndexedDbCacheStore> {
		const layout = resolveIndexedDbLayout(
			typeof options === "string" ? { database: options } : options,
		);
		const store = createStore(layout.database, layout.store);
		await get(ACTIVE, store);
		return new IndexedDbCacheStore(store, layout.separator);
	}

	public async hasChunk(chunkHash: string): Promise<boolean> {
		const value = await get(this.#chunkKey(chunkHash), this.#store);
		const bytes = storedBytes(value, MAX_COMPRESSED_CHUNK_BYTES);
		if (bytes !== null && bytes.byteLength > 0) return true;
		if (value !== undefined) await del(this.#chunkKey(chunkHash), this.#store);
		return false;
	}

	public async putChunkCompressed(
		chunkHash: string,
		compressed: Uint8Array,
		expectedSize: number,
	): Promise<void> {
		if (compressed.byteLength === 0) {
			throw new IntegrityError("compressed chunk must not be empty");
		}
		if (compressed.byteLength > MAX_COMPRESSED_CHUNK_BYTES) {
			throw new IntegrityError(
				"compressed chunk exceeds the IndexedDB read cap",
			);
		}
		await decompressAndVerify(chunkHash, compressed, expectedSize);
		await this.#write(this.#chunkKey(chunkHash), compressed.slice());
	}

	public async getChunk(
		chunkHash: string,
		expectedSize: number,
	): Promise<Uint8Array> {
		const key = this.#chunkKey(chunkHash);
		try {
			const bytes = storedBytes(
				await get(key, this.#store),
				MAX_COMPRESSED_CHUNK_BYTES,
			);
			if (bytes === null || bytes.byteLength === 0) {
				throw new IntegrityError(`chunk ${chunkHash} is missing or empty`);
			}
			return await decompressAndVerify(chunkHash, bytes, expectedSize);
		} catch (error) {
			if (error instanceof IntegrityError) await del(key, this.#store);
			throw error;
		}
	}

	public async putManifest(bytes: Uint8Array): Promise<string> {
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
			throw new IntegrityError(
				"manifest is empty or exceeds the IndexedDB read cap",
			);
		}
		const hash = await sha256Hex(bytes);
		await this.#write(this.#manifestKey(hash), bytes.slice());
		return hash;
	}

	public async getManifest(hash: string): Promise<Uint8Array> {
		const key = this.#manifestKey(hash);
		try {
			const bytes = storedBytes(
				await get(key, this.#store),
				MAX_MANIFEST_BYTES,
			);
			if (bytes === null || bytes.byteLength === 0) {
				throw new IntegrityError(`manifest ${hash} is missing or empty`);
			}
			if ((await sha256Hex(bytes)) !== hash) {
				throw new IntegrityError(
					`manifest ${hash} failed content-address check`,
				);
			}
			return bytes;
		} catch (error) {
			if (error instanceof IntegrityError) await del(key, this.#store);
			throw error;
		}
	}

	public readActive(): Promise<VersionPointer | null> {
		return get(ACTIVE, this.#store).then(parseActiveValue);
	}

	public async promote(pointer: VersionPointer): Promise<void> {
		try {
			await update(
				ACTIVE,
				(value: unknown) => {
					if (!canPromotePointer(parseActiveValue(value), pointer)) {
						throw new Error(
							`refusing to promote sequence ${pointer.sequence} over durable pointer`,
						);
					}
					return new TextEncoder().encode(JSON.stringify(pointer));
				},
				this.#store,
			);
		} catch (error) {
			throw translateStorageError(error);
		}
	}

	public async clearActiveIf(expected: VersionPointer): Promise<boolean> {
		return this.#store("readwrite", async (store) => {
			const value = await promisifyRequest(store.get(ACTIVE));
			if (!samePointer(parseActiveValue(value), expected)) return false;
			store.delete(ACTIVE);
			await promisifyRequest(store.transaction);
			return true;
		});
	}

	public async pruneInactive(): Promise<void> {
		const active = await this.readActive();
		if (active === null) return;
		let manifest: unknown;
		try {
			manifest = JSON.parse(
				new TextDecoder().decode(await this.getManifest(active.manifest_hash)),
			) as unknown;
		} catch {
			return;
		}
		const keep = activeKeys(active, manifest, this.#separator);
		if (keep === null) return;
		const stale = (await keys<IDBValidKey>(this.#store)).filter(
			(key) => typeof key === "string" && !keep.has(key),
		);
		if (stale.length > 0) await delMany(stale, this.#store);
	}

	public clear(): Promise<void> {
		return clear(this.#store);
	}

	#chunkKey(hash: string): string {
		return `chunk${this.#separator}${hash}`;
	}

	#manifestKey(hash: string): string {
		return `manifest${this.#separator}${hash}`;
	}

	async #write(key: string, value: Uint8Array): Promise<void> {
		try {
			await set(key, value, this.#store);
		} catch (error) {
			// IndexedDB writes are transactional: a failed put leaves the previous
			// value intact. Deleting here would turn quota pressure into data loss.
			throw translateStorageError(error);
		}
	}
}

function storedBytes(value: unknown, cap: number): Uint8Array | null {
	if (ArrayBuffer.isView(value) && value.byteLength <= cap) {
		return new Uint8Array(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).slice();
	}
	if (
		Object.prototype.toString.call(value) === "[object ArrayBuffer]" &&
		(value as ArrayBuffer).byteLength <= cap
	) {
		return new Uint8Array(value as ArrayBuffer).slice();
	}
	return null;
}

function parseActiveValue(value: unknown): VersionPointer | null {
	if (
		ArrayBuffer.isView(value) ||
		Object.prototype.toString.call(value) === "[object ArrayBuffer]"
	) {
		const bytes = storedBytes(value, MAX_ACTIVE_BYTES);
		if (bytes === null || bytes.byteLength === 0) return null;
		try {
			return parseStoredPointer(
				JSON.parse(new TextDecoder().decode(bytes)) as unknown,
			);
		} catch {
			return null;
		}
	}
	try {
		const serialized = JSON.stringify(value);
		if (
			serialized === undefined ||
			new TextEncoder().encode(serialized).byteLength > MAX_ACTIVE_BYTES
		)
			return null;
		return parseStoredPointer(value);
	} catch {
		return null;
	}
}

function activeKeys(
	pointer: VersionPointer,
	manifest: unknown,
	separator: IndexedDbLayout["separator"],
): ReadonlySet<string> | null {
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		Array.isArray(manifest)
	) {
		return null;
	}
	const files = (manifest as { files?: unknown }).files;
	if (!Array.isArray(files)) return null;
	const keep = new Set([
		ACTIVE,
		`manifest${separator}${pointer.manifest_hash}`,
	]);
	for (const file of files) {
		if (typeof file !== "object" || file === null || Array.isArray(file))
			return null;
		const chunks = (file as { chunks?: unknown }).chunks;
		if (!Array.isArray(chunks)) return null;
		for (const chunk of chunks) {
			if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk))
				return null;
			const hash = (chunk as { hash?: unknown }).hash;
			if (typeof hash !== "string" || !SHA256.test(hash)) return null;
			keep.add(`chunk${separator}${hash}`);
		}
	}
	return keep;
}

function validatedName(value: string, label: string): string {
	if (!/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
		throw new TypeError(
			`IndexedDB ${label} must start with a letter and contain only lowercase letters, digits, or hyphens`,
		);
	}
	return value;
}
