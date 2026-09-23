// Keyring rotation, revocation and pointer expiry through the sync state
// machine. Keys come from FIXED seeds (RFC 8032 signatures are deterministic)
// and every clock is injected — nothing here reads the wall clock except the
// one test that pins the default clock's behavior on far-past/far-future
// deadlines.

import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { SignatureError, sha256Hex, verifyEd25519 } from "./crypto.js";
import { classifyEngineError } from "./engineError.js";
import { NetworkError } from "./fetchBytes.js";
import { catalogFetch, pubkeyRaw } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import {
	deriveKeyId,
	KEYRING_SCHEMA,
	KeyRevokedError,
	type Keyring,
	KeyringError,
	parseTrustRoot,
	UnknownKeyError,
} from "./keyring.js";
import { MemoryCacheStore } from "./memoryStore.js";
import {
	type KeyringSyncArgs,
	PointerExpiredError,
	pointerSigningBytes,
	RollbackError,
	type SyncArgs,
	syncIndex,
} from "./sync.js";
import type { FetchBytes, IndexManifest, VersionPointer } from "./types.js";

const ENCODER = new TextEncoder();
const EXPIRES_AT = 1_767_225_600;
const before = (): number => EXPIRES_AT - 1;
const at = (): number => EXPIRES_AT;
const offline: FetchBytes = () => Promise.reject(new NetworkError("offline"));

interface Party {
	readonly seed: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly keyId: string;
	readonly entry: { readonly key_id: string; readonly public_key: string };
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function party(fill: number): Promise<Party> {
	const seed = new Uint8Array(32).fill(fill);
	const publicKey = await getPublicKeyAsync(seed);
	const keyId = await deriveKeyId(publicKey);
	return {
		seed,
		publicKey,
		keyId,
		entry: { key_id: keyId, public_key: hex(publicKey) },
	};
}

async function ring(
	keys: ReadonlyArray<Party>,
	revoked: ReadonlyArray<Party> = [],
): Promise<Keyring> {
	return parseTrustRoot(
		ENCODER.encode(
			JSON.stringify({
				schema: KEYRING_SCHEMA,
				keys: keys.map((key) => key.entry),
				revoked: revoked.map((key) => key.keyId),
			}),
		),
	);
}

type Unsigned = Omit<VersionPointer, "signature">;

/** Independent of the engine's preimage helper: every field here is
 * non-null, so the preimage is simply the canonical pointer minus signature. */
async function signPointer(
	unsigned: Unsigned,
	signer: Party,
): Promise<VersionPointer> {
	const message = canonicalBytes(unsigned as unknown as JsonValue);
	const signature = await signAsync(message, signer.seed);
	return { ...unsigned, signature: btoa(String.fromCharCode(...signature)) };
}

interface Origin {
	readonly fetchBytes: FetchBytes;
	readonly requests: () => ReadonlyArray<string>;
}

async function release(
	version: string,
	sequence: number,
	signer: Party,
	extra: Partial<Unsigned> = {},
): Promise<{ readonly pointer: VersionPointer; readonly origin: Origin }> {
	const manifest: IndexManifest = {
		schema_version: 2,
		bundle_id: "keyring-test",
		version,
		files: [],
		metadata: {},
	};
	const manifestBytes = ENCODER.encode(JSON.stringify(manifest));
	const manifestHash = await sha256Hex(manifestBytes);
	const pointer = await signPointer(
		{
			manifest_hash: manifestHash,
			version,
			bundle_id: "keyring-test",
			channel: "stable",
			sequence,
			...extra,
		},
		signer,
	);
	return { pointer, origin: serve(pointer, manifestBytes) };
}

function serve(pointer: unknown, manifestBytes?: Uint8Array): Origin {
	const requested: string[] = [];
	return {
		requests: () => requested,
		fetchBytes: (url) => {
			requested.push(url);
			if (url.endsWith("/latest")) {
				return Promise.resolve(ENCODER.encode(JSON.stringify(pointer)));
			}
			if (url.includes("/manifest/") && manifestBytes !== undefined) {
				return Promise.resolve(manifestBytes);
			}
			return Promise.reject(new Error(`unexpected ${url}`));
		},
	};
}

function keyringArgs(
	keyring: Keyring,
	origin: Pick<Origin, "fetchBytes">,
	store: MemoryCacheStore,
	now: () => number = before,
): KeyringSyncArgs {
	return { baseUrl: "/o", store, fetchBytes: origin.fetchBytes, keyring, now };
}

describe("the legacy single-key trust root is unchanged", () => {
	it("syncs the committed real bundle through a keyring of one raw key", async () => {
		const legacy = await parseTrustRoot(pubkeyRaw());
		const catalog = catalogFetch();
		const store = new MemoryCacheStore();
		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: catalog.fetchBytes,
			keyring: legacy,
		});
		expect(result.chunksFetched).toBeGreaterThan(0);
		expect("expired" in result).toBe(false);

		// Offline, the same ring re-verifies the cached (key_id-less) pointer.
		const cached = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: offline,
			keyring: legacy,
		});
		expect(cached).toEqual({
			...result,
			chunksFetched: 0,
			chunksReused: result.chunksFetched + result.chunksReused,
			bytesFetched: 0,
		});
	});

	it("still refuses a pointer the one key did not sign", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const { origin } = await release("v1", 1, b);
		await expect(
			syncIndex(
				keyringArgs(
					await parseTrustRoot(a.publicKey),
					origin,
					new MemoryCacheStore(),
				),
			),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("keeps the old preimage for a pointer without the new fields", async () => {
		const a = await party(0x01);
		const { pointer } = await release("v1", 1, a);
		const legacy = canonicalBytes(pointer as unknown as JsonValue, {
			exclude: { signature: true },
		});
		expect(pointerSigningBytes(pointer)).toEqual(legacy);
		expect(
			pointerSigningBytes({ ...pointer, key_id: null, expires_at: null }),
		).toEqual(legacy);
	});

	it("folds present key_id/expires_at into the signed preimage", async () => {
		const a = await party(0x01);
		const { pointer } = await release("v1", 1, a, {
			key_id: a.keyId,
			expires_at: EXPIRES_AT,
		});
		const text = new TextDecoder().decode(pointerSigningBytes(pointer));
		expect(text).toContain(`"expires_at":${EXPIRES_AT},`);
		expect(text).toContain(`"key_id":"${a.keyId}",`);
		expect(text).not.toContain("signature");
	});
});

describe("key selection", () => {
	it("verifies a key_id pointer under that key and promotes it", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const { pointer, origin } = await release("v1", 1, b, { key_id: b.keyId });
		const store = new MemoryCacheStore();
		const result = await syncIndex(
			keyringArgs(await ring([a, b]), origin, store),
		);
		expect(result.version).toBe("v1");
		expect(await store.readActive()).toEqual(pointer);
	});

	it("refuses a revoked key_id after one request, promoting nothing", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const { origin } = await release("v1", 1, a, { key_id: a.keyId });
		const store = new MemoryCacheStore();
		await expect(
			syncIndex(keyringArgs(await ring([a, b], [a]), origin, store)),
		).rejects.toBeInstanceOf(KeyRevokedError);
		expect(origin.requests()).toEqual(["/o/latest"]);
		expect(await store.readActive()).toBeNull();
	});

	it("refuses an unknown key_id", async () => {
		const a = await party(0x01);
		const c = await party(0x03);
		const { origin } = await release("v1", 1, c, { key_id: c.keyId });
		const refusal = syncIndex(
			keyringArgs(await ring([a]), origin, new MemoryCacheStore()),
		);
		await expect(refusal).rejects.toBeInstanceOf(UnknownKeyError);
		expect(
			classifyEngineError(await refusal.catch((error: unknown) => error)).code,
		).toBe("integrity");
	});

	it("refuses a key_id-less pointer signed only by a revoked key", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const { origin } = await release("v1", 1, a);
		await expect(
			syncIndex(
				keyringArgs(await ring([a, b], [a]), origin, new MemoryCacheStore()),
			),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("revalidates a hand-built keyring before trusting it", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const { origin } = await release("v1", 1, a);
		const mislabeled: Keyring = {
			keys: [{ keyId: b.keyId, publicKey: a.publicKey }],
			revoked: [],
		};
		await expect(
			syncIndex(keyringArgs(mislabeled, origin, new MemoryCacheStore())),
		).rejects.toBeInstanceOf(KeyringError);
		expect(origin.requests()).toEqual([]);
	});
});

describe("the verifier is chosen unambiguously", () => {
	it("refuses both a verify function and a keyring", async () => {
		const a = await party(0x01);
		const { origin } = await release("v1", 1, a);
		const args = {
			...keyringArgs(await ring([a]), origin, new MemoryCacheStore()),
			verify: () => Promise.resolve(),
		} as unknown as SyncArgs;
		await expect(syncIndex(args)).rejects.toBeInstanceOf(TypeError);
		expect(origin.requests()).toEqual([]);
	});

	it("refuses neither a verify function nor a keyring", async () => {
		const args = {
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			fetchBytes: offline,
		} as unknown as SyncArgs;
		await expect(syncIndex(args)).rejects.toBeInstanceOf(TypeError);
	});
});

describe("new pointer fields are bounded before any other fetch", () => {
	it.each([
		["an uppercase key_id", { key_id: "34750F98BD59FCFC" }],
		["a 15-char key_id", { key_id: "34750f98bd59fcf" }],
		["a 17-char key_id", { key_id: "34750f98bd59fcfc0" }],
		["a numeric key_id", { key_id: 7 }],
		["an empty key_id", { key_id: "" }],
		["a zero expires_at", { expires_at: 0 }],
		["a negative expires_at", { expires_at: -1 }],
		["a fractional expires_at", { expires_at: 1.5 }],
		["a string expires_at", { expires_at: "1767225600" }],
		["an unsafe expires_at", { expires_at: 2 ** 53 }],
	])("rejects %s as an integrity failure", async (_label, field) => {
		const a = await party(0x01);
		const { pointer } = await release("v1", 1, a);
		const origin = serve({ ...pointer, ...field });
		await expect(
			syncIndex(keyringArgs(await ring([a]), origin, new MemoryCacheStore())),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(origin.requests()).toEqual(["/o/latest"]);
	});

	it("accepts the largest safe expires_at", async () => {
		const a = await party(0x01);
		const { origin } = await release("v1", 1, a, {
			expires_at: Number.MAX_SAFE_INTEGER,
		});
		await expect(
			syncIndex(keyringArgs(await ring([a]), origin, new MemoryCacheStore())),
		).resolves.toMatchObject({ version: "v1" });
	});
});

describe("pointer expiry", () => {
	async function expiring(): Promise<{
		readonly keyring: Keyring;
		readonly signer: Party;
		readonly pointer: VersionPointer;
		readonly origin: Origin;
	}> {
		const signer = await party(0x02);
		const { pointer, origin } = await release("v1", 4, signer, {
			key_id: signer.keyId,
			expires_at: EXPIRES_AT,
		});
		return { keyring: await ring([signer]), signer, pointer, origin };
	}

	it("accepts a network pointer one second before expiry", async () => {
		const { keyring, origin } = await expiring();
		const result = await syncIndex(
			keyringArgs(keyring, origin, new MemoryCacheStore(), before),
		);
		expect(result.version).toBe("v1");
		expect("expired" in result).toBe(false);
	});

	it("refuses a network pointer at expiry, before any manifest fetch", async () => {
		const { keyring, origin } = await expiring();
		const store = new MemoryCacheStore();
		const refusal = syncIndex(keyringArgs(keyring, origin, store, at));
		await expect(refusal).rejects.toBeInstanceOf(PointerExpiredError);
		expect(origin.requests()).toEqual(["/o/latest"]);
		expect(await store.readActive()).toBeNull();
		const error = await refusal.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(IntegrityError);
		expect(classifyEngineError(error).code).toBe("integrity");
		expect((error as Error).name).toBe("PointerExpiredError");
	});

	it("checks the signature before the deadline", async () => {
		const { keyring, pointer } = await expiring();
		const forged = serve({ ...pointer, version: "v2" });
		await expect(
			syncIndex(keyringArgs(keyring, forged, new MemoryCacheStore(), at)),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("is enforced on the legacy verify path too", async () => {
		const { signer, origin } = await expiring();
		await expect(
			syncIndex({
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				fetchBytes: origin.fetchBytes,
				verify: (message, signature) =>
					verifyEd25519(signer.publicKey, message, signature),
				now: at,
			}),
		).rejects.toBeInstanceOf(PointerExpiredError);
	});

	it("serves an expired CACHED bundle offline, flagged expired", async () => {
		const { keyring, pointer, origin } = await expiring();
		const store = new MemoryCacheStore();
		const online = await syncIndex(keyringArgs(keyring, origin, store, before));

		const stale = await syncIndex(
			keyringArgs(keyring, { fetchBytes: offline }, store, at),
		);
		expect(stale).toEqual({
			...online,
			chunksFetched: 0,
			bytesFetched: 0,
			expired: true,
		});
		expect(await store.readActive()).toEqual(pointer);
	});

	it("does not flag an unexpired cached bundle", async () => {
		const { keyring, origin } = await expiring();
		const store = new MemoryCacheStore();
		await syncIndex(keyringArgs(keyring, origin, store, before));
		const cached = await syncIndex(
			keyringArgs(keyring, { fetchBytes: offline }, store, before),
		);
		expect("expired" in cached).toBe(false);
	});

	it("uses the wall clock only as the default, in Unix seconds", async () => {
		const signer = await party(0x02);
		const keyring = await ring([signer]);
		const past = await release("v1", 1, signer, { expires_at: 1 });
		const future = await release("v1", 1, signer, {
			expires_at: Number.MAX_SAFE_INTEGER,
		});
		const { now: _drop, ...pastArgs } = keyringArgs(
			keyring,
			past.origin,
			new MemoryCacheStore(),
		);
		const { now: _keep, ...futureArgs } = keyringArgs(
			keyring,
			future.origin,
			new MemoryCacheStore(),
		);
		await expect(syncIndex(pastArgs)).rejects.toBeInstanceOf(
			PointerExpiredError,
		);
		await expect(syncIndex(futureArgs)).resolves.toMatchObject({
			version: "v1",
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"fails closed when the clock returns %s",
		async (reading) => {
			const { keyring, origin } = await expiring();
			await expect(
				syncIndex(
					keyringArgs(keyring, origin, new MemoryCacheStore(), () => reading),
				),
			).rejects.toBeInstanceOf(TypeError);
		},
	);

	it("never consults the clock for a pointer without expires_at", async () => {
		const a = await party(0x01);
		const { origin } = await release("v1", 1, a);
		let reads = 0;
		await syncIndex(
			keyringArgs(await ring([a]), origin, new MemoryCacheStore(), () => {
				reads += 1;
				return Number.NaN;
			}),
		);
		expect(reads).toBe(0);
	});
});

describe("rotation A -> B keeps the rollback floor", () => {
	async function rotated(): Promise<{
		readonly a: Party;
		readonly b: Party;
		readonly store: MemoryCacheStore;
		readonly activeA: VersionPointer;
		readonly afterRotation: Keyring;
	}> {
		const a = await party(0x01);
		const b = await party(0x02);
		const store = new MemoryCacheStore();
		const first = await release("v10", 10, a, { key_id: a.keyId });
		await syncIndex(keyringArgs(await ring([a]), first.origin, store));
		return {
			a,
			b,
			store,
			activeA: first.pointer,
			afterRotation: await ring([b], [a]),
		};
	}

	it("refuses an older release signed by B as a rollback", async () => {
		const { b, store, activeA, afterRotation } = await rotated();
		const replay = await release("v5", 5, b, { key_id: b.keyId });
		await expect(
			syncIndex(keyringArgs(afterRotation, replay.origin, store)),
		).rejects.toBeInstanceOf(RollbackError);
		expect(replay.origin.requests()).toEqual(["/o/latest"]);
		expect(await store.readActive()).toEqual(activeA);
	});

	it("promotes a fresher release signed by B", async () => {
		const { b, store, afterRotation } = await rotated();
		const next = await release("v11", 11, b, { key_id: b.keyId });
		await syncIndex(keyringArgs(afterRotation, next.origin, store));
		expect(await store.readActive()).toEqual(next.pointer);
	});

	it("refuses to serve a cache signed by the now-revoked key", async () => {
		const { store, activeA, afterRotation } = await rotated();
		await expect(
			syncIndex(keyringArgs(afterRotation, { fetchBytes: offline }, store)),
		).rejects.toBeInstanceOf(KeyRevokedError);
		expect(await store.readActive()).toEqual(activeA);
	});

	it("serves a cache signed by A while A is still listed and unrevoked", async () => {
		const { a, b, store } = await rotated();
		const result = await syncIndex(
			keyringArgs(await ring([a, b]), { fetchBytes: offline }, store),
		);
		expect(result.version).toBe("v10");
	});

	it("serves a key_id-less cached pointer under any non-revoked key", async () => {
		const a = await party(0x01);
		const b = await party(0x02);
		const store = new MemoryCacheStore();
		const legacy = await release("v1", 1, a);
		await syncIndex(keyringArgs(await ring([a]), legacy.origin, store));

		await expect(
			syncIndex(
				keyringArgs(await ring([b, a]), { fetchBytes: offline }, store),
			),
		).resolves.toMatchObject({ version: "v1" });
		await expect(
			syncIndex(
				keyringArgs(await ring([b, a], [a]), { fetchBytes: offline }, store),
			),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("keeps the floor after a revoked cache was refused", async () => {
		const { b, store, afterRotation } = await rotated();
		await expect(
			syncIndex(keyringArgs(afterRotation, { fetchBytes: offline }, store)),
		).rejects.toBeInstanceOf(KeyRevokedError);
		const replay = await release("v9", 9, b, { key_id: b.keyId });
		await expect(
			syncIndex(keyringArgs(afterRotation, replay.origin, store)),
		).rejects.toBeInstanceOf(RollbackError);
	});
});
