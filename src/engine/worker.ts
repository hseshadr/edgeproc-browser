// The sync engine's Worker entry. It owns the OPFS store (sync access handles
// are Worker-only) and the engine; the main thread drives it over postMessage.
// One concern: route a request to the engine, reply with a typed envelope.

/// <reference lib="webworker" />

import { cacheDatabaseName, runWithCacheLock } from "./cacheLock.js";
import { verifyEd25519 } from "./crypto.js";
import { classifyEngineError } from "./engineError.js";
import { fetchBytes } from "./fetchBytes.js";
import {
	type IndexedDbLayout,
	type IndexedDbLayoutOptions,
	resolveIndexedDbLayout,
} from "./indexedDbStore.js";
import { installNetworkSentinel } from "./networkSentinel.js";
import {
	openPersistentCacheStore,
	type PersistentCacheStore,
	requestPersistentStorage,
} from "./persistentStore.js";
import type {
	ClearRequest,
	EngineRequest,
	EngineResponse,
	ReadFileRequest,
	SyncRequest,
} from "./protocol.js";
import { materializeFile, syncIndex } from "./sync.js";
import type {
	IndexManifest,
	StoragePreference,
	VersionPointer,
} from "./types.js";

const DECODER = new TextDecoder();

// This Worker fetches the signed bundle, so its traffic must be visible to the
// tab's network counter — the window cannot see a Worker's resource timeline.
installNetworkSentinel("engine-worker");

interface StoreConfiguration {
	readonly namespace: string;
	readonly storageBackend: StoragePreference;
	readonly indexedDbLayout: IndexedDbLayout;
}

let storeState:
	| (StoreConfiguration & { readonly promise: Promise<PersistentCacheStore> })
	| null = null;

function store(
	configuration?: Partial<Omit<StoreConfiguration, "indexedDbLayout">> & {
		readonly indexedDbLayout?: IndexedDbLayoutOptions;
	},
): Promise<PersistentCacheStore> {
	const namespace = configuration?.namespace ?? "edgeproc-browser";
	const storageBackend = configuration?.storageBackend ?? "auto";
	const indexedDbLayout = resolveIndexedDbLayout(
		configuration?.indexedDbLayout,
		cacheDatabaseName(namespace),
	);
	if (storeState === null) {
		storeState = {
			namespace,
			storageBackend,
			indexedDbLayout,
			promise: openPersistentCacheStore({
				namespace,
				storageBackend,
				indexedDbLayout,
			}),
		};
	} else if (
		storeState.namespace !== namespace ||
		storeState.storageBackend !== storageBackend ||
		storeState.indexedDbLayout.database !== indexedDbLayout.database ||
		storeState.indexedDbLayout.store !== indexedDbLayout.store ||
		storeState.indexedDbLayout.separator !== indexedDbLayout.separator
	) {
		throw new Error(
			"engine worker cache configuration cannot change after first use",
		);
	}
	return storeState.promise;
}

async function loadPubkey(pubkeyUrl: string): Promise<Uint8Array> {
	return fetchBytes(pubkeyUrl, { cache: "no-store" });
}

async function handleSync(req: SyncRequest): Promise<EngineResponse> {
	requestPersistentStorage(navigator.storage);
	const namespace = req.cacheNamespace ?? "edgeproc-browser";
	const cacheStore = await store({
		namespace,
		storageBackend: req.storageBackend ?? "auto",
		...(req.indexedDbLayout === undefined
			? {}
			: { indexedDbLayout: req.indexedDbLayout }),
	});
	return runWithCacheLock(
		lockManager(),
		async () => {
			const pubkey = await loadPubkey(req.pubkeyUrl);
			const result = await syncIndex({
				baseUrl: req.baseUrl,
				store: cacheStore,
				fetchBytes,
				verify: (message, signature) =>
					verifyEd25519(pubkey, message, signature),
				...(req.expectedBundleId === undefined
					? {}
					: { expectedBundleId: req.expectedBundleId }),
				...(req.expectedChannel === undefined
					? {}
					: { expectedChannel: req.expectedChannel }),
				...(req.wantedPaths === undefined
					? {}
					: { wantedPaths: req.wantedPaths }),
				onProgress: (progress) => {
					self.postMessage({
						ok: true,
						id: req.id,
						kind: "syncProgress",
						progress,
					} satisfies EngineResponse);
				},
			});
			return {
				ok: true,
				id: req.id,
				kind: "sync",
				result: { ...result, cacheBackend: cacheStore.cacheBackend },
			};
		},
		namespace,
	);
}

async function handleReadFile(req: ReadFileRequest): Promise<EngineResponse> {
	const configuration = storeState ?? {
		namespace: "edgeproc-browser",
		storageBackend: "auto" as const,
	};
	const cacheStore = await store(configuration);
	return runWithCacheLock(
		lockManager(),
		async () => {
			const manifest = await loadActiveManifest(cacheStore);
			const bytes = await materializeFile(cacheStore, manifest, req.path);
			return { ok: true, id: req.id, kind: "readFile", bytes };
		},
		configuration.namespace,
	);
}

async function handleClear(req: ClearRequest): Promise<EngineResponse> {
	const namespace =
		req.cacheNamespace ?? storeState?.namespace ?? "edgeproc-browser";
	const storageBackend =
		req.storageBackend ?? storeState?.storageBackend ?? "auto";
	const indexedDbLayout = req.indexedDbLayout ?? storeState?.indexedDbLayout;
	const cacheStore = await store({
		namespace,
		storageBackend,
		...(indexedDbLayout === undefined ? {} : { indexedDbLayout }),
	});
	return runWithCacheLock(
		lockManager(),
		async () => {
			await cacheStore.clear();
			return { ok: true, id: req.id, kind: "clear" };
		},
		namespace,
	);
}

async function loadActiveManifest(
	cacheStore: PersistentCacheStore,
): Promise<IndexManifest> {
	const active: VersionPointer | null = await cacheStore.readActive();
	if (active === null) {
		throw new Error("no active version — sync first");
	}
	const raw = await cacheStore.getManifest(active.manifest_hash);
	const manifest = JSON.parse(DECODER.decode(raw)) as IndexManifest;
	return manifest;
}

function lockManager():
	| { request<T>(name: string, operation: () => Promise<T>): Promise<T> }
	| undefined {
	return navigator.locks === undefined
		? undefined
		: {
				request: (name, operation) => navigator.locks.request(name, operation),
			};
}

async function handle(req: EngineRequest): Promise<EngineResponse> {
	switch (req.kind) {
		case "sync":
			return handleSync(req);
		case "readFile":
			return handleReadFile(req);
		case "clear":
			return handleClear(req);
	}
}

self.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
	const req = event.data;
	handle(req)
		.then((response) => {
			if (response.ok && response.kind === "readFile") {
				self.postMessage(response, { transfer: [response.bytes.buffer] });
				return;
			}
			self.postMessage(response);
		})
		.catch((error: unknown) => {
			const response: EngineResponse = {
				ok: false,
				id: req.id,
				kind: req.kind,
				error: classifyEngineError(error),
			};
			self.postMessage(response);
		});
});
