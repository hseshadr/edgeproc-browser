// A real signed-bundle sync, end to end, with no network and no browser.
//
// This is the whole package in ~60 lines: point it at a content-addressed
// bundle, give it a fail-closed ed25519 verifier, and it either hands you
// verified bytes or throws. It runs against the REAL signed bundle committed at
// src/engine/__fixtures__/bundle — produced by the Python publisher, the same
// one the test suite uses — so nothing here is mocked except the transport,
// which is injected precisely so "no network" is structural.
//
// Run it:  pnpm install && pnpm demo
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
	verifyEd25519,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "src", "engine", "__fixtures__", "bundle");
const read = (...p) => new Uint8Array(readFileSync(join(BUNDLE, ...p)));
const DECODER = new TextDecoder();

// The pinned key. It is the ONLY thing trusted here — not the origin, not TLS.
const PUBKEY = read("keys", "public.key");
const verify = (message, signature) =>
	verifyEd25519(PUBKEY, message, signature);

// The transport is a seam, so this demo provably makes zero network calls.
const requested = [];
const fetchBytes = (url) => {
	requested.push(url);
	if (url.endsWith("/latest"))
		return Promise.resolve(read("catalog", "latest"));
	const manifest = url.match(/\/manifest\/([0-9a-f]+)$/);
	if (manifest)
		return Promise.resolve(read("catalog", "manifest", manifest[1]));
	const chunk = url.match(/\/chunk\/([0-9a-f]+)$/);
	if (chunk) return Promise.resolve(read("catalog", "chunk", chunk[1]));
	return Promise.reject(new Error(`unexpected url ${url}`));
};

const store = new MemoryCacheStore();

console.log("1. syncing the signed bundle into a content-addressed store...");
const result = await syncIndex({ baseUrl: "/cat", store, fetchBytes, verify });
console.log(`   version        ${result.version}`);
console.log(`   manifest       ${result.manifestHash.slice(0, 16)}...`);
console.log(
	`   chunks fetched ${result.chunksFetched}, reused ${result.chunksReused}`,
);
console.log(`   bytes fetched  ${result.bytesFetched}`);
console.log(`   http requests  ${requested.length}`);

const manifest = JSON.parse(
	DECODER.decode(await store.getManifest(result.manifestHash)),
);
console.log(
	`\n2. reassembling ${manifest.files.length} files, each verified...`,
);
for (const entry of manifest.files) {
	const bytes = await materializeFile(store, manifest, entry.path);
	if (bytes.byteLength !== entry.size) {
		console.error(`   FAIL: ${entry.path} size mismatch`);
		process.exit(1);
	}
}
console.log(`   all ${manifest.files.length} files match their signed sha256.`);

console.log("\n3. a second sync over the primed store refetches nothing:");
const again = await syncIndex({
	baseUrl: "/cat",
	store,
	fetchBytes,
	verify,
});
console.log(
	`   chunks fetched ${again.chunksFetched} (reused ${again.chunksReused})`,
);

// The part that matters. Flip ONE bit of the pinned key: the very same bundle,
// byte for byte, must now be REJECTED. Not degraded, not served from cache.
console.log(
	"\n4. fail-closed check — same bundle, one bit flipped in the key:",
);
const forged = new Uint8Array(PUBKEY);
forged[0] ^= 0x01;
try {
	await syncIndex({
		baseUrl: "/cat",
		store: new MemoryCacheStore(),
		fetchBytes,
		verify: (message, signature) => verifyEd25519(forged, message, signature),
	});
	console.error("   FAIL: a bundle signed by another key was ACCEPTED");
	process.exit(1);
} catch (error) {
	console.log(
		`   rejected with ${error.constructor.name} — fail-closed holds.`,
	);
}
