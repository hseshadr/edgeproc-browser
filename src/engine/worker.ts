// The sync engine's Worker entry. It owns the OPFS store (sync access handles
// are Worker-only) and the engine; the main thread drives it over postMessage.
// One concern: route a request to the engine, reply with a typed envelope.

/// <reference lib="webworker" />

import { verifyEd25519 } from "./crypto.js";
import { fetchBytes } from "./fetchBytes.js";
import { installNetworkSentinel } from "./networkSentinel.js";
import { OpfsCacheStore } from "./opfsStore.js";
import type {
	EngineRequest,
	EngineResponse,
	ReadFileRequest,
	SyncRequest,
} from "./protocol.js";
import { materializeFile, syncIndex } from "./sync.js";
import type { IndexManifest, VersionPointer } from "./types.js";

const DECODER = new TextDecoder();

// This Worker fetches the signed bundle, so its traffic must be visible to the
// tab's network counter — the window cannot see a Worker's resource timeline.
installNetworkSentinel("engine-worker");

let storePromise: Promise<OpfsCacheStore> | null = null;
let activeManifest: IndexManifest | null = null;

function store(): Promise<OpfsCacheStore> {
	if (storePromise === null) {
		storePromise = OpfsCacheStore.open();
	}
	return storePromise;
}

async function loadPubkey(pubkeyUrl: string): Promise<Uint8Array> {
	return fetchBytes(pubkeyUrl);
}

async function handleSync(req: SyncRequest): Promise<EngineResponse> {
	void navigator.storage.persist?.().catch(() => false); // best-effort, never blocks
	const cacheStore = await store();
	const pubkey = await loadPubkey(req.pubkeyUrl);
	const result = await syncIndex({
		baseUrl: req.baseUrl,
		store: cacheStore,
		fetchBytes,
		verify: (message, signature) => verifyEd25519(pubkey, message, signature),
		expectedBundleId: req.expectedBundleId,
		expectedChannel: req.expectedChannel,
	});
	const raw = await cacheStore.getManifest(result.manifestHash);
	activeManifest = JSON.parse(DECODER.decode(raw)) as IndexManifest;
	return { ok: true, id: req.id, kind: "sync", result };
}

async function handleReadFile(req: ReadFileRequest): Promise<EngineResponse> {
	const manifest = activeManifest ?? (await loadActiveManifest());
	const bytes = await materializeFile(await store(), manifest, req.path);
	return { ok: true, id: req.id, kind: "readFile", bytes };
}

async function loadActiveManifest(): Promise<IndexManifest> {
	const cacheStore = await store();
	const active: VersionPointer | null = await cacheStore.readActive();
	if (active === null) {
		throw new Error("no active version — sync first");
	}
	const raw = await cacheStore.getManifest(active.manifest_hash);
	const manifest = JSON.parse(DECODER.decode(raw)) as IndexManifest;
	activeManifest = manifest;
	return manifest;
}

async function handle(req: EngineRequest): Promise<EngineResponse> {
	switch (req.kind) {
		case "sync":
			return handleSync(req);
		case "readFile":
			return handleReadFile(req);
	}
}

self.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
	const req = event.data;
	handle(req)
		.then((response) => {
			self.postMessage(response);
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const response: EngineResponse = {
				ok: false,
				id: req.id,
				error: message,
			};
			self.postMessage(response);
		});
});
