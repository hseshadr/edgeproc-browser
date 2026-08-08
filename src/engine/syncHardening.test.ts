import { Zstd } from "@hpcc-js/wasm-zstd";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { materializeFile, RollbackError, syncIndex } from "./sync.js";
import type {
	FetchBytes,
	FileEntry,
	IndexManifest,
	Verify,
	VersionPointer,
} from "./types.js";

const ENCODER = new TextEncoder();
const passVerify: Verify = () => Promise.resolve();
/** sha256 of zero bytes — the file hash of an empty, chunk-less file entry. */
const EMPTY_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface SyntheticOrigin {
	readonly fetchBytes: FetchBytes;
	readonly pointer: VersionPointer;
	readonly requestCount: () => number;
}

async function originFor(
	manifest: IndexManifest,
	chunks: ReadonlyMap<string, Uint8Array> = new Map(),
	sequence = 1,
): Promise<SyntheticOrigin> {
	const manifestBytes = ENCODER.encode(JSON.stringify(manifest));
	const manifestHash = await sha256Hex(manifestBytes);
	const pointer: VersionPointer = {
		manifest_hash: manifestHash,
		version: manifest.version,
		bundle_id: manifest.bundle_id,
		channel: "stable",
		sequence,
		signature: "test-signature",
	};
	let requests = 0;
	const fetchBytes: FetchBytes = (url) => {
		requests += 1;
		if (url.endsWith("/latest")) {
			return Promise.resolve(ENCODER.encode(JSON.stringify(pointer)));
		}
		if (url.endsWith(`/manifest/${manifestHash}`)) {
			return Promise.resolve(manifestBytes);
		}
		const hash = url.split("/").at(-1);
		const compressed = hash === undefined ? undefined : chunks.get(hash);
		return compressed === undefined
			? Promise.reject(new Error(`unexpected ${url}`))
			: Promise.resolve(compressed);
	};
	return { fetchBytes, pointer, requestCount: () => requests };
}

function emptyManifest(overrides: Partial<IndexManifest> = {}): IndexManifest {
	return {
		schema_version: 2,
		bundle_id: "hardening-test",
		version: "v1",
		files: [],
		metadata: {},
		...overrides,
	};
}

function pointerFetch(
	origin: SyntheticOrigin,
	overrides: Partial<VersionPointer>,
): FetchBytes {
	return (url, options) => {
		if (url.endsWith("/latest")) {
			return Promise.resolve(
				ENCODER.encode(JSON.stringify({ ...origin.pointer, ...overrides })),
			);
		}
		return origin.fetchBytes(url, options);
	};
}

/** A zero-byte, chunk-less file — enough manifest shape to reach a guard. */
function emptyFile(path = "empty.bin"): FileEntry {
	return {
		path,
		file_type: null,
		size: 0,
		file_sha256: EMPTY_HASH,
		chunks: [],
	};
}

describe("the incoming pointer is validated before it is acted on", () => {
	// A malformed pointer must be refused on the ONE fetch that produced it.
	// `requests === 1` is the whole assertion: if any of these shapes reaches
	// the manifest fetch, the client has already spent a round trip acting on
	// bytes it never validated. Every case here is a distinct parse branch.
	it.each([
		["a null pointer", null],
		["an invalid manifest hash", { manifest_hash: "not-a-hash" }],
		["an empty version", { version: "" }],
		["an empty signature", { signature: "" }],
		["a negative sequence", { sequence: -1 }],
		["a non-string identity", { bundle_id: 7 }],
	])("rejects %s before any immutable fetch", async (_label, malformed) => {
		const origin = await originFor(emptyManifest());
		const value =
			malformed === null ? null : { ...origin.pointer, ...malformed };
		let requests = 0;
		const fetchBytes: FetchBytes = () => {
			requests += 1;
			return Promise.resolve(ENCODER.encode(JSON.stringify(value)));
		};

		await expect(
			syncIndex({
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				fetchBytes,
				verify: passVerify,
			}),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(requests).toBe(1);
	});

	// The pins are checked on the CACHED pointer too. Offline is the moment a
	// caller most wants an answer, and it is exactly where an identity check
	// that only runs on the network path would silently stop running.
	it("applies identity pins to an offline cached pointer", async () => {
		const origin = await originFor(emptyManifest());
		const store = new MemoryCacheStore();
		await syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify });

		await expect(
			syncIndex({
				baseUrl: "/o",
				store,
				fetchBytes: () => Promise.reject(new NetworkError("offline")),
				verify: passVerify,
				expectedBundleId: "some-other-bundle",
				expectedChannel: "stable",
			}),
		).rejects.toThrow(/expected bundle identity/iu);
	});

	// The identity fields are OPTIONAL on the wire. A pointer that carries no
	// bundle_id/channel still syncs and still gets a sequence — the pins bind
	// only what the caller asked to bind.
	it("syncs an identity-less pointer when the caller pins nothing", async () => {
		const origin = await originFor(emptyManifest());
		const {
			bundle_id: _bundleId,
			channel: _channel,
			...unbound
		} = origin.pointer;
		const store = new MemoryCacheStore();
		const fetchBytes: FetchBytes = (url, options) =>
			url.endsWith("/latest")
				? Promise.resolve(ENCODER.encode(JSON.stringify(unbound)))
				: origin.fetchBytes(url, options);

		await syncIndex({ baseUrl: "/o", store, fetchBytes, verify: passVerify });

		expect((await store.readActive())?.sequence).toBe(1);
	});

	// Both pins refuse on the pointer, before the manifest fetch, and promote
	// nothing — a wrong bundle must cost exactly one request.
	it.each([
		["bundle identity", { expectedBundleId: "some-other-bundle" }],
		["release channel", { expectedChannel: "preview" }],
	])(
		"rejects the wrong expected %s before fetching its manifest",
		async (_label, pin) => {
			const origin = await originFor(emptyManifest());
			const store = new MemoryCacheStore();

			await expect(
				syncIndex({
					...origin,
					...pin,
					baseUrl: "/o",
					store,
					verify: passVerify,
				}),
			).rejects.toThrow(/expected/iu);
			expect(origin.requestCount()).toBe(1);
			expect(await store.readActive()).toBeNull();
		},
	);

	// The pointer is signed; the manifest is not. It is bound to the pointer by
	// content address, so any field the two both carry must agree or one of
	// them is not the thing that was signed.
	it.each([
		["version", { version: "other" }],
		["bundle identity", { bundle_id: "other" }],
	] as const)(
		"rejects pointer/manifest %s disagreement",
		async (_l, pointer) => {
			const origin = await originFor(emptyManifest());

			await expect(
				syncIndex({
					baseUrl: "/o",
					store: new MemoryCacheStore(),
					fetchBytes: pointerFetch(origin, pointer),
					verify: passVerify,
				}),
			).rejects.toThrow(/differ/iu);
		},
	);

	// An INJECTED transport is not trusted to have honoured the cap it was
	// handed. sync re-measures what came back, because `fetchBytes` is a seam a
	// consumer supplies and the cap is sync's invariant, not the transport's.
	it("rejects an injected transport response above the caller's cap", async () => {
		const origin = await originFor(emptyManifest());
		const oversized = `${JSON.stringify(origin.pointer)}${" ".repeat(16 * 1024)}`;

		await expect(
			syncIndex({
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				fetchBytes: () => Promise.resolve(ENCODER.encode(oversized)),
				verify: passVerify,
			}),
		).rejects.toThrow(/response cap/iu);
	});
});

describe("manifest shape is validated before a single chunk is fetched", () => {
	// Two entries for one path: the second silently wins on any map-building
	// reader, so which bytes land under that name stops being determined by the
	// signature.
	it("rejects duplicate file paths", async () => {
		const origin = await originFor(
			emptyManifest({ files: [emptyFile(), emptyFile()] }),
		);

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				verify: passVerify,
			}),
		).rejects.toThrow(/repeats path/iu);
	});

	// One content hash, two declared sizes. The store is keyed by hash, so the
	// second size would be checked against bytes fetched under the first —
	// a manifest that cannot be self-consistent must not be acted on at all.
	it("rejects conflicting sizes for one content hash", async () => {
		const hash = "a".repeat(64);
		const files = [1, 2].map((size, index) => ({
			...emptyFile(`f-${index}`),
			size,
			chunks: [{ hash, size }],
		}));
		const origin = await originFor(emptyManifest({ files }));

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				verify: passVerify,
			}),
		).rejects.toThrow(/conflicting sizes/iu);
	});

	// The UNCOMPRESSED total, which is the number that decides how much memory
	// reassembly will ask for. Bounding only the fetched (compressed) bytes
	// leaves the expansion factor attacker-controlled.
	it("rejects excessive aggregate uncompressed file bytes", async () => {
		const chunk = { hash: "b".repeat(64), size: 8 * 1024 * 1024 };
		const files = Array.from({ length: 3 }, (_, index) => ({
			...emptyFile(`large-${index}`),
			size: 256 * 1024 * 1024,
			chunks: Array.from({ length: 32 }, () => chunk),
		}));
		const origin = await originFor(emptyManifest({ files }));

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				verify: passVerify,
			}),
		).rejects.toThrow(/uncompressed cap/iu);
	});

	// An unknown schema means the guards below were written against a shape
	// this manifest may not have. Two requests: pointer, manifest — and then it
	// stops, rather than interpreting v3 fields with v2 rules.
	it("rejects an unknown manifest schema before fetching chunks", async () => {
		const origin = await originFor(emptyManifest({ schema_version: 3 }));
		const store = new MemoryCacheStore();

		await expect(
			syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify }),
		).rejects.toThrow(/schema/iu);
		expect(origin.requestCount()).toBe(2);
		expect(await store.readActive()).toBeNull();
	});
});

describe("signed monotonic pointer contract", () => {
	it("rejects a lower sequence before fetching its manifest", async () => {
		const origin = await originFor(emptyManifest(), new Map(), 5);
		const store = new MemoryCacheStore();
		await syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify });
		let requests = 0;
		const replay = pointerFetch(origin, { sequence: 4 });

		await expect(
			syncIndex({
				baseUrl: "/o",
				store,
				fetchBytes: (url, options) => {
					requests += 1;
					return replay(url, options);
				},
				verify: passVerify,
			}),
		).rejects.toBeInstanceOf(RollbackError);
		expect(requests).toBe(1);
		expect((await store.readActive())?.sequence).toBe(5);
	});

	it("rejects equal-sequence equivocation before fetching its manifest", async () => {
		const origin = await originFor(emptyManifest(), new Map(), 5);
		const store = new MemoryCacheStore();
		await syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify });
		let requests = 0;
		const fork = pointerFetch(origin, {
			manifest_hash: "f".repeat(64),
			version: "fork",
		});

		await expect(
			syncIndex({
				baseUrl: "/o",
				store,
				fetchBytes: (url, options) => {
					requests += 1;
					return fork(url, options);
				},
				verify: passVerify,
			}),
		).rejects.toBeInstanceOf(RollbackError);
		expect(requests).toBe(1);
	});

	it("requires a sequence on every incoming pointer", async () => {
		const origin = await originFor(emptyManifest());
		const store = new MemoryCacheStore();
		const sequenceLess: FetchBytes = (url, options) => {
			if (url.endsWith("/latest")) {
				const { sequence: _sequence, ...legacy } = origin.pointer;
				return Promise.resolve(ENCODER.encode(JSON.stringify(legacy)));
			}
			return origin.fetchBytes(url, options);
		};

		await expect(
			syncIndex({
				baseUrl: "/o",
				store,
				fetchBytes: sequenceLess,
				verify: passVerify,
			}),
		).rejects.toThrow(/sequence/iu);
		expect(await store.readActive()).toBeNull();
	});

	it("allows one migration from a cached legacy active pointer", async () => {
		const origin = await originFor(emptyManifest());
		const store = new MemoryCacheStore();
		const legacy = {
			manifest_hash: origin.pointer.manifest_hash,
			version: origin.pointer.version,
			signature: "legacy-signature",
		} as unknown as VersionPointer;
		await store.promote(legacy);

		await syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify });

		expect((await store.readActive())?.sequence).toBe(1);
	});
});

/**
 * Anti-rollback must be a PROOF of freshness, not the absence of disproof.
 *
 * Every case below is a REAL rollback driven through `syncIndex`: a validly
 * signed but stale `/latest` is replayed at a client whose durable pointer can
 * no longer prove how fresh it is. The guard used to answer "cannot compare"
 * with "then it is not a rollback" and promote the stale bundle — fail-OPEN,
 * the same defect class already fixed in edge-proc's `cas.py`. Proof must come
 * from a monotonic counter or a comparable version; neither speaking is a
 * refusal.
 */
describe("anti-rollback fails closed", () => {
	/** Replay `stale`'s signed pointer at a store already holding `active`. */
	function replay(
		store: MemoryCacheStore,
		stale: SyntheticOrigin,
	): Promise<unknown> {
		return syncIndex({
			baseUrl: "/o",
			store,
			fetchBytes: stale.fetchBytes,
			verify: passVerify,
		});
	}

	it("refuses a replay when the cached counter is present but unparseable", async () => {
		// Sequence 5 of v1 is live; the durable counter is then corrupted to a
		// non-integer — a tampered or truncated cache entry. An ABSENT counter is
		// the legacy-migration case and the version decides it; a PRESENT but
		// unparseable one is not. Here the version cannot decide either (same
		// release string, DIFFERENT manifest), so the only thing standing between
		// the client and the older bundle is refusing to read a corrupt counter as
		// proof. Isolated on purpose: nothing else in the guard can refuse this.
		const live = await originFor(
			emptyManifest({ version: "v1" }),
			new Map(),
			5,
		);
		const replayed = await originFor(
			emptyManifest({ version: "v1", metadata: { build: "older" } }),
			new Map(),
			4,
		);
		const store = new MemoryCacheStore();
		await syncIndex({ ...live, baseUrl: "/o", store, verify: passVerify });
		await store.promote({
			...live.pointer,
			sequence: null,
		} as unknown as VersionPointer);

		await expect(replay(store, replayed)).rejects.toBeInstanceOf(RollbackError);
		expect((await store.readActive())?.manifest_hash).toBe(
			live.pointer.manifest_hash,
		);
	});

	it("refuses a counter-less active whose version cannot prove freshness", async () => {
		// The literal finding: an UNPARSEABLE version used to bypass the check
		// instead of failing it. With no counter to compare and "nightly" not a
		// comparable release, nothing proves the incoming pointer is fresher.
		const origin = await originFor(emptyManifest({ version: "v1" }));
		const store = new MemoryCacheStore();
		await store.promote({
			manifest_hash: "b".repeat(64),
			version: "nightly",
			signature: "legacy-signature",
		} as unknown as VersionPointer);

		await expect(replay(store, origin)).rejects.toBeInstanceOf(RollbackError);
		expect((await store.readActive())?.version).toBe("nightly");
	});

	it("refuses an equal-version fork of a counter-less active pointer", async () => {
		// Equal versions prove freshness only for the SAME manifest. A different
		// manifest at the same version is an equivocating fork, and with no
		// counter there is nothing left to decide it.
		const origin = await originFor(emptyManifest({ version: "v1" }));
		const store = new MemoryCacheStore();
		await store.promote({
			manifest_hash: "c".repeat(64),
			version: "v1",
			signature: "legacy-signature",
		} as unknown as VersionPointer);

		await expect(replay(store, origin)).rejects.toBeInstanceOf(RollbackError);
		expect((await store.readActive())?.manifest_hash).toBe("c".repeat(64));
	});

	it("still promotes a provably fresher release over a counter-less active", async () => {
		// The fail-closed rule must not brick the legacy upgrade path: a
		// comparable, strictly newer version is proof, so v2 lands.
		const origin = await originFor(emptyManifest({ version: "v2" }));
		const store = new MemoryCacheStore();
		await store.promote({
			manifest_hash: "d".repeat(64),
			version: "v1",
			signature: "legacy-signature",
		} as unknown as VersionPointer);

		await syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify });

		expect((await store.readActive())?.version).toBe("v2");
	});
});

describe("bounded sync resources", () => {
	it("uses parallel chunk workers without exceeding eight in flight", async () => {
		const zstd = await Zstd.load();
		const chunks = new Map<string, Uint8Array>();
		const refs = [];
		for (let index = 0; index < 20; index += 1) {
			const bytes = ENCODER.encode(`bounded chunk ${index}`);
			const hash = await sha256Hex(bytes);
			refs.push({ hash, size: bytes.byteLength });
			chunks.set(hash, zstd.compress(bytes));
		}
		const file = ENCODER.encode(
			refs.map((_, index) => `bounded chunk ${index}`).join(""),
		);
		const manifest = emptyManifest({
			files: [
				{
					path: "chunks.bin",
					file_type: null,
					size: refs.reduce((total, ref) => total + ref.size, 0),
					file_sha256: await sha256Hex(file),
					chunks: refs,
				},
			],
		});
		const origin = await originFor(manifest, chunks);
		let inFlight = 0;
		let maximum = 0;
		const delayed: FetchBytes = async (url, options) => {
			if (!url.includes("/chunk/")) return origin.fetchBytes(url, options);
			inFlight += 1;
			maximum = Math.max(maximum, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			try {
				return await origin.fetchBytes(url, options);
			} finally {
				inFlight -= 1;
			}
		};

		await syncIndex({
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			fetchBytes: delayed,
			verify: passVerify,
		});

		expect(maximum).toBeGreaterThan(1);
		expect(maximum).toBeLessThanOrEqual(8);
	});

	it("rejects an excessive file count before fetching chunks", async () => {
		// One past the MAX_SYNC_FILES cap (1024): the file-count guard must fire
		// before any chunk fetch. Kept in lock-step with the cap in sync.ts.
		const files = Array.from({ length: 1025 }, (_, index) => ({
			path: `f-${index}`,
			file_type: null,
			size: 0,
			file_sha256:
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			chunks: [],
		}));
		const origin = await originFor(emptyManifest({ files }));
		const store = new MemoryCacheStore();

		await expect(
			syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify }),
		).rejects.toThrow(/file/iu);
		expect(origin.requestCount()).toBe(2);
		expect(await store.readActive()).toBeNull();
	});

	it("rejects aggregate fetched bytes before storing or promoting", async () => {
		const bytes = ENCODER.encode("larger than the injected aggregate ceiling");
		const hash = await sha256Hex(bytes);
		const zstd = await Zstd.load();
		const manifest = emptyManifest({
			files: [
				{
					path: "one.bin",
					file_type: null,
					size: bytes.byteLength,
					file_sha256: hash,
					chunks: [{ hash, size: bytes.byteLength }],
				},
			],
		});
		const origin = await originFor(
			manifest,
			new Map([[hash, zstd.compress(bytes)]]),
		);
		const store = new MemoryCacheStore();

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store,
				verify: passVerify,
				limits: { maxTotalFetchBytes: 1 },
			}),
		).rejects.toThrow(/aggregate/iu);
		expect(await store.hasChunk(hash)).toBe(false);
		expect(await store.readActive()).toBeNull();
	});

	it("bounds zstd output by the signed chunk size", async () => {
		const zstd = await Zstd.load();
		const bomb = new Uint8Array(9 * 1024 * 1024);
		const declared = new Uint8Array([0]);
		const hash = await sha256Hex(declared);
		const manifest = emptyManifest({
			files: [
				{
					path: "bomb.bin",
					file_type: null,
					size: 1,
					file_sha256: hash,
					chunks: [{ hash, size: 1 }],
				},
			],
		});
		const origin = await originFor(
			manifest,
			new Map([[hash, zstd.compress(bomb)]]),
		);
		const store = new MemoryCacheStore();

		await expect(
			syncIndex({ ...origin, baseUrl: "/o", store, verify: passVerify }),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(await store.readActive()).toBeNull();
	});

	// The aggregate cap has to be RESERVED, not reconciled. Chunk downloads run
	// eight at a time, so a budget checked only after each response resolves is
	// a budget eight requests can blow past together. What proves the reservation
	// is the per-request ceiling each fetch is HANDED: summed, it never exceeds
	// the aggregate, which is only true if the budget was debited before the
	// concurrent calls went out.
	it("reserves the aggregate cap before concurrent chunk downloads", async () => {
		const zstd = await Zstd.load();
		const bytes = ENCODER.encode("bounded");
		const hash = await sha256Hex(bytes);
		const refs = Array.from({ length: 8 }, () => ({
			hash,
			size: bytes.byteLength,
		}));
		const fileBytes = new Uint8Array(bytes.length * refs.length);
		for (let index = 0; index < refs.length; index += 1) {
			fileBytes.set(bytes, index * bytes.length);
		}
		const manifest = emptyManifest({
			files: [
				{
					path: "bounded.bin",
					file_type: null,
					size: bytes.byteLength * refs.length,
					file_sha256: await sha256Hex(fileBytes),
					chunks: refs,
				},
			],
		});
		const origin = await originFor(
			manifest,
			new Map([[hash, zstd.compress(bytes)]]),
		);
		const reservations: number[] = [];
		const fetchBytes: FetchBytes = (url, options) => {
			if (url.includes("/chunk/")) reservations.push(options?.maxBytes ?? 0);
			return origin.fetchBytes(url, options);
		};

		await syncIndex({
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			fetchBytes,
			verify: passVerify,
			limits: { maxTotalFetchBytes: 256 },
		});

		expect(reservations.length).toBeGreaterThan(0);
		expect(
			reservations.reduce((sum, value) => sum + value, 0),
		).toBeLessThanOrEqual(256);
	});

	// Zero is not "no limit". A cap the caller injects is a number sync must
	// treat as adversarial input like any other, or `maxTotalFetchBytes: 0`
	// reads as an unbounded budget instead of an impossible one.
	it("rejects a non-positive injected aggregate cap", async () => {
		const origin = await originFor(emptyManifest());

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				verify: passVerify,
				limits: { maxTotalFetchBytes: 0 },
			}),
		).rejects.toThrow(/positive/iu);
	});
});

describe("reassembly is verified against the signed whole-file hash", () => {
	// Every chunk verifies against its own content address and the file still
	// must not be served: chunk hashes prove the PARTS, `file_sha256` proves
	// the ORDER and the set. Only the whole-file check can catch a manifest
	// that reorders or drops valid chunks.
	it("rejects a reassembled file whose signed whole-file hash differs", async () => {
		const bytes = ENCODER.encode("verified chunk, wrong file hash");
		const hash = await sha256Hex(bytes);
		const zstd = await Zstd.load();
		const manifest = emptyManifest({
			files: [
				{
					path: "wrong-file-hash.bin",
					file_type: null,
					size: bytes.byteLength,
					file_sha256: "f".repeat(64),
					chunks: [{ hash, size: bytes.byteLength }],
				},
			],
		});
		const origin = await originFor(
			manifest,
			new Map([[hash, zstd.compress(bytes)]]),
		);

		await expect(
			syncIndex({
				...origin,
				baseUrl: "/o",
				store: new MemoryCacheStore(),
				verify: passVerify,
			}),
		).rejects.toThrow(/reassembly/iu);
	});

	// The manifest is the allow-list. A path it does not name has no signed
	// hash to check bytes against, so there is no safe way to answer for it.
	it("rejects materializing a path absent from the verified manifest", async () => {
		await expect(
			materializeFile(new MemoryCacheStore(), emptyManifest(), "missing.bin"),
		).rejects.toThrow(/not in manifest/iu);
	});
});
