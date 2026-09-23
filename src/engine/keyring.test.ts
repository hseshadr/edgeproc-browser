import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { SignatureError } from "./crypto.js";
import { classifyEngineError } from "./engineError.js";
import { IntegrityError } from "./integrity.js";
import {
	assertKeyring,
	deriveKeyId,
	KEYRING_SCHEMA,
	KeyRevokedError,
	type Keyring,
	KeyringError,
	loadTrustRoot,
	MAX_TRUST_ROOT_BYTES,
	parseTrustRoot,
	UnknownKeyError,
	verifyWithKeyring,
} from "./keyring.js";
import type { FetchBytesOptions } from "./types.js";

const ENCODER = new TextEncoder();
const SEED_A = new Uint8Array(32).fill(0x01);
const SEED_B = new Uint8Array(32).fill(0x02);
const SEED_C = new Uint8Array(32).fill(0x03);

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

interface Party {
	readonly seed: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly keyId: string;
	readonly entry: { readonly key_id: string; readonly public_key: string };
}

async function party(seed: Uint8Array): Promise<Party> {
	const publicKey = await getPublicKeyAsync(seed);
	const keyId = await deriveKeyId(publicKey);
	return {
		seed,
		publicKey,
		keyId,
		entry: { key_id: keyId, public_key: hex(publicKey) },
	};
}

function json(value: unknown): Uint8Array {
	return ENCODER.encode(JSON.stringify(value));
}

async function sign(message: Uint8Array, signer: Party): Promise<string> {
	return base64(await signAsync(message, signer.seed));
}

describe("key identity", () => {
	it("is the first 16 lowercase hex chars of sha256(raw public key)", async () => {
		const a = await party(SEED_A);
		const b = await party(SEED_B);
		// Pinned independently (Python cryptography + hashlib) — see the
		// cross-runtime vectors in __fixtures__/keyring_vectors.json.
		expect(a.keyId).toBe("34750f98bd59fcfc");
		expect(b.keyId).toBe("6a3803d5f059902a");
	});
});

describe("trust root: legacy raw key", () => {
	it("treats exactly 32 bytes as a keyring of one, unchanged", async () => {
		const a = await party(SEED_A);
		const ring = await parseTrustRoot(a.publicKey);
		expect(ring.revoked).toEqual([]);
		expect(ring.keys).toHaveLength(1);
		expect(ring.keys[0]?.keyId).toBe(a.keyId);
		expect(ring.keys[0]?.publicKey).toEqual(a.publicKey);
	});

	it("copies the key so later mutation of the input cannot swap it", async () => {
		const a = await party(SEED_A);
		const raw = new Uint8Array(a.publicKey);
		const ring = await parseTrustRoot(raw);
		raw.fill(0);
		expect(ring.keys[0]?.publicKey).toEqual(a.publicKey);
	});

	it.each([0, 31, 33, 64])(
		"refuses %i bytes that are neither a key nor JSON",
		async (length) => {
			await expect(
				parseTrustRoot(new Uint8Array(length).fill(0x41)),
			).rejects.toBeInstanceOf(KeyringError);
		},
	);
});

describe("trust root: JSON keyring", () => {
	it("parses a strict edgeproc.keyring/v1 document", async () => {
		const a = await party(SEED_A);
		const b = await party(SEED_B);
		const ring = await parseTrustRoot(
			json({
				schema: KEYRING_SCHEMA,
				keys: [a.entry, b.entry],
				revoked: [a.keyId],
			}),
		);
		expect(ring.keys.map((key) => key.keyId)).toEqual([a.keyId, b.keyId]);
		expect(ring.keys[1]?.publicKey).toEqual(b.publicKey);
		expect(ring.revoked).toEqual([a.keyId]);
	});

	it("accepts revoked ids whose public key is no longer listed", async () => {
		const a = await party(SEED_A);
		const b = await party(SEED_B);
		const ring = await parseTrustRoot(
			json({ schema: KEYRING_SCHEMA, keys: [b.entry], revoked: [a.keyId] }),
		);
		expect(ring.keys).toHaveLength(1);
		expect(ring.revoked).toEqual([a.keyId]);
	});

	it("bounds the document before decoding it", async () => {
		const oversized = new Uint8Array(MAX_TRUST_ROOT_BYTES + 1).fill(0x20);
		await expect(parseTrustRoot(oversized)).rejects.toThrow(/exceeds/iu);
	});

	it("refuses invalid UTF-8", async () => {
		await expect(
			parseTrustRoot(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x20])),
		).rejects.toBeInstanceOf(KeyringError);
	});

	type Mutation = (document: Record<string, unknown>, a: Party) => unknown;
	const cases: ReadonlyArray<readonly [string, Mutation]> = [
		["not an object", () => [1, 2, 3]],
		["null", () => null],
		["a wrong schema", (d) => ({ ...d, schema: "edgeproc.keyring/v2" })],
		["a missing schema", ({ schema: _s, ...rest }) => rest],
		["an unknown top-level field", (d) => ({ ...d, extra: true })],
		["a missing keys list", ({ keys: _k, ...rest }) => rest],
		["a missing revoked list", ({ revoked: _r, ...rest }) => rest],
		["keys that are not an array", (d) => ({ ...d, keys: {} })],
		["an empty keys list", (d) => ({ ...d, keys: [] })],
		["a key entry that is not an object", (d) => ({ ...d, keys: ["x"] })],
		[
			"a key entry with an unknown field",
			(d, a) => ({ ...d, keys: [{ ...a.entry, algorithm: "ed25519" }] }),
		],
		[
			"a key entry missing its public key",
			(d, a) => ({ ...d, keys: [{ key_id: a.keyId }] }),
		],
		[
			"an uppercase key id",
			(d, a) => ({
				...d,
				keys: [{ ...a.entry, key_id: a.keyId.toUpperCase() }],
			}),
		],
		[
			"a short key id",
			(d, a) => ({ ...d, keys: [{ ...a.entry, key_id: a.keyId.slice(1) }] }),
		],
		[
			"an uppercase public key",
			(d, a) => ({
				...d,
				keys: [{ ...a.entry, public_key: a.entry.public_key.toUpperCase() }],
			}),
		],
		[
			"a 31-byte public key",
			(d, a) => ({
				...d,
				keys: [{ ...a.entry, public_key: a.entry.public_key.slice(2) }],
			}),
		],
		[
			"a key id that is not derived from its key",
			(d, a) => ({
				...d,
				keys: [{ ...a.entry, key_id: "0123456789abcdef" }],
			}),
		],
		["a duplicate key", (d, a) => ({ ...d, keys: [a.entry, a.entry] })],
		["revoked that is not an array", (d) => ({ ...d, revoked: "x" })],
		["a malformed revoked id", (d) => ({ ...d, revoked: ["NOT-HEX"] })],
		["a non-string revoked id", (d) => ({ ...d, revoked: [7] })],
		[
			"a duplicate revoked id",
			(d) => ({ ...d, revoked: ["0123456789abcdef", "0123456789abcdef"] }),
		],
		["every key revoked", (d, a) => ({ ...d, revoked: [a.keyId] })],
		[
			"too many keys",
			(d, a) => ({ ...d, keys: Array.from({ length: 65 }, () => a.entry) }),
		],
		[
			"too many revoked ids",
			(d) => ({
				...d,
				revoked: Array.from({ length: 1025 }, (_, index) =>
					index.toString(16).padStart(16, "0"),
				),
			}),
		],
	];

	it.each(cases)("refuses %s", async (_label, mutate) => {
		const a = await party(SEED_A);
		const document = {
			schema: KEYRING_SCHEMA,
			keys: [a.entry],
			revoked: [],
		};
		const bytes = json(mutate(document, a));
		const refusal = parseTrustRoot(bytes);
		await expect(refusal).rejects.toBeInstanceOf(KeyringError);
		// A broken trust root is an integrity verdict at the Worker boundary.
		const error = await refusal.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(IntegrityError);
		expect(classifyEngineError(error).code).toBe("integrity");
	});

	it("refuses malformed JSON as a keyring error", async () => {
		await expect(
			parseTrustRoot(ENCODER.encode('{"schema": ')),
		).rejects.toBeInstanceOf(KeyringError);
	});
});

describe("hand-built keyrings are revalidated", () => {
	it.each<readonly [string, (a: Party, b: Party) => Keyring]>([
		["an empty ring", () => ({ keys: [], revoked: [] })],
		[
			"a mislabeled key",
			(a, b) => ({
				keys: [{ keyId: b.keyId, publicKey: a.publicKey }],
				revoked: [],
			}),
		],
		[
			"a short key",
			(a) => ({
				keys: [{ keyId: a.keyId, publicKey: a.publicKey.slice(1) }],
				revoked: [],
			}),
		],
		[
			"a duplicate key",
			(a) => ({
				keys: [
					{ keyId: a.keyId, publicKey: a.publicKey },
					{ keyId: a.keyId, publicKey: a.publicKey },
				],
				revoked: [],
			}),
		],
		[
			"a malformed revoked id",
			(a) => ({
				keys: [{ keyId: a.keyId, publicKey: a.publicKey }],
				revoked: ["x"],
			}),
		],
		[
			"every key revoked",
			(a) => ({
				keys: [{ keyId: a.keyId, publicKey: a.publicKey }],
				revoked: [a.keyId],
			}),
		],
	])("refuses %s", async (_label, build) => {
		const ring = build(await party(SEED_A), await party(SEED_B));
		await expect(assertKeyring(ring)).rejects.toBeInstanceOf(KeyringError);
	});

	it("refuses a value that is not a keyring at all", async () => {
		await expect(
			assertKeyring(null as unknown as Keyring),
		).rejects.toBeInstanceOf(KeyringError);
	});
});

describe("verification under a keyring", () => {
	const message = ENCODER.encode("pointer preimage");

	async function rings(): Promise<{
		readonly a: Party;
		readonly b: Party;
		readonly both: Keyring;
		readonly rotated: Keyring;
	}> {
		const a = await party(SEED_A);
		const b = await party(SEED_B);
		const both = await parseTrustRoot(
			json({ schema: KEYRING_SCHEMA, keys: [a.entry, b.entry], revoked: [] }),
		);
		const rotated = await parseTrustRoot(
			json({
				schema: KEYRING_SCHEMA,
				keys: [a.entry, b.entry],
				revoked: [a.keyId],
			}),
		);
		return { a, b, both, rotated };
	}

	it("selects the key named by key_id", async () => {
		const { a, b, both } = await rings();
		await expect(
			verifyWithKeyring(both, message, await sign(message, a), a.keyId),
		).resolves.toBeUndefined();
		await expect(
			verifyWithKeyring(both, message, await sign(message, b), b.keyId),
		).resolves.toBeUndefined();
	});

	it("never falls back to another key when key_id names one", async () => {
		const { a, b, both } = await rings();
		await expect(
			verifyWithKeyring(both, message, await sign(message, a), b.keyId),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("refuses a revoked key_id even with a valid signature", async () => {
		const { a, rotated } = await rings();
		const refusal = verifyWithKeyring(
			rotated,
			message,
			await sign(message, a),
			a.keyId,
		);
		await expect(refusal).rejects.toBeInstanceOf(KeyRevokedError);
		await expect(refusal).rejects.toBeInstanceOf(SignatureError);
	});

	it("refuses an unknown key_id", async () => {
		const { both } = await rings();
		const c = await party(SEED_C);
		const refusal = verifyWithKeyring(
			both,
			message,
			await sign(message, c),
			c.keyId,
		);
		await expect(refusal).rejects.toBeInstanceOf(UnknownKeyError);
		await expect(refusal).rejects.toBeInstanceOf(SignatureError);
	});

	it("accepts a key_id-less signature from any non-revoked key", async () => {
		const { a, b, both } = await rings();
		for (const signer of [a, b]) {
			await expect(
				verifyWithKeyring(both, message, await sign(message, signer)),
			).resolves.toBeUndefined();
			await expect(
				verifyWithKeyring(both, message, await sign(message, signer), null),
			).resolves.toBeUndefined();
		}
	});

	it("never accepts a key_id-less signature from a revoked key", async () => {
		const { a, b, rotated } = await rings();
		await expect(
			verifyWithKeyring(rotated, message, await sign(message, a)),
		).rejects.toBeInstanceOf(SignatureError);
		await expect(
			verifyWithKeyring(rotated, message, await sign(message, b)),
		).resolves.toBeUndefined();
	});

	it("refuses a signature no ring key produced", async () => {
		const { both } = await rings();
		const c = await party(SEED_C);
		await expect(
			verifyWithKeyring(both, message, await sign(message, c)),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("gives the new errors stable names", () => {
		expect(new KeyRevokedError().name).toBe("KeyRevokedError");
		expect(new UnknownKeyError().name).toBe("UnknownKeyError");
		expect(new KeyringError("x").name).toBe("KeyringError");
		expect(classifyEngineError(new KeyRevokedError()).code).toBe("integrity");
		expect(classifyEngineError(new UnknownKeyError()).code).toBe("integrity");
	});
});

describe("trust-root transport", () => {
	it("fetches without HTTP-cache reuse and under a byte cap", async () => {
		const a = await party(SEED_A);
		const seen: Array<FetchBytesOptions | undefined> = [];
		const ring = await loadTrustRoot("/keys/public.key", (url, options) => {
			expect(url).toBe("/keys/public.key");
			seen.push(options);
			return Promise.resolve(a.publicKey);
		});
		expect(seen).toEqual([
			{ cache: "no-store", maxBytes: MAX_TRUST_ROOT_BYTES },
		]);
		expect(ring.keys[0]?.keyId).toBe(a.keyId);
	});

	it("re-checks the cap when an injected transport ignores it", async () => {
		await expect(
			loadTrustRoot("/keys/public.key", () =>
				Promise.resolve(new Uint8Array(MAX_TRUST_ROOT_BYTES + 1)),
			),
		).rejects.toBeInstanceOf(KeyringError);
	});
});
