// The sync engine's Worker entry. It owns the OPFS store (sync access handles
// are Worker-only) and the engine; the main thread drives it over postMessage.
// One concern: route a request to the engine, reply with a typed envelope.
/// <reference lib="webworker" />
import { cacheDatabaseName, runWithCacheLock } from "./cacheLock.js";
import { classifyEngineError } from "./engineError.js";
import { fetchBytes } from "./fetchBytes.js";
import { resolveIndexedDbLayout, } from "./indexedDbStore.js";
import { loadTrustRoot } from "./keyring.js";
import { installNetworkSentinel } from "./networkSentinel.js";
import { openPersistentCacheStore, requestPersistentStorage, } from "./persistentStore.js";
import { materializeFile, syncIndex } from "./sync.js";
const DECODER = new TextDecoder();
// This Worker fetches the signed bundle, so its traffic must be visible to the
// tab's network counter — the window cannot see a Worker's resource timeline.
installNetworkSentinel("engine-worker");
let storeState = null;
function store(configuration) {
    const namespace = configuration?.namespace ?? "edgeproc-browser";
    const storageBackend = configuration?.storageBackend ?? "auto";
    const indexedDbLayout = resolveIndexedDbLayout(configuration?.indexedDbLayout, cacheDatabaseName(namespace));
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
    }
    else if (storeState.namespace !== namespace ||
        storeState.storageBackend !== storageBackend ||
        storeState.indexedDbLayout.database !== indexedDbLayout.database ||
        storeState.indexedDbLayout.store !== indexedDbLayout.store ||
        storeState.indexedDbLayout.separator !== indexedDbLayout.separator) {
        throw new Error("engine worker cache configuration cannot change after first use");
    }
    return storeState.promise;
}
async function handleSync(req) {
    requestPersistentStorage(navigator.storage);
    const namespace = req.cacheNamespace ?? "edgeproc-browser";
    const cacheStore = await store({
        namespace,
        storageBackend: req.storageBackend ?? "auto",
        ...(req.indexedDbLayout === undefined
            ? {}
            : { indexedDbLayout: req.indexedDbLayout }),
    });
    return runWithCacheLock(lockManager(), async () => {
        // The trust root: a legacy raw 32-byte key (a keyring of one) or an
        // edgeproc.keyring/v1 JSON document, fetched no-store and size-capped.
        const keyring = await loadTrustRoot(req.pubkeyUrl, fetchBytes);
        const result = await syncIndex({
            baseUrl: req.baseUrl,
            store: cacheStore,
            fetchBytes,
            keyring,
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
                });
            },
        });
        return {
            ok: true,
            id: req.id,
            kind: "sync",
            result: { ...result, cacheBackend: cacheStore.cacheBackend },
        };
    }, namespace);
}
async function handleReadFile(req) {
    const configuration = storeState ?? {
        namespace: "edgeproc-browser",
        storageBackend: "auto",
    };
    const cacheStore = await store(configuration);
    return runWithCacheLock(lockManager(), async () => {
        const manifest = await loadActiveManifest(cacheStore);
        const bytes = await materializeFile(cacheStore, manifest, req.path);
        return { ok: true, id: req.id, kind: "readFile", bytes };
    }, configuration.namespace);
}
async function handleClear(req) {
    const namespace = req.cacheNamespace ?? storeState?.namespace ?? "edgeproc-browser";
    const storageBackend = req.storageBackend ?? storeState?.storageBackend ?? "auto";
    const indexedDbLayout = req.indexedDbLayout ?? storeState?.indexedDbLayout;
    const cacheStore = await store({
        namespace,
        storageBackend,
        ...(indexedDbLayout === undefined ? {} : { indexedDbLayout }),
    });
    return runWithCacheLock(lockManager(), async () => {
        await cacheStore.clear();
        return { ok: true, id: req.id, kind: "clear" };
    }, namespace);
}
async function loadActiveManifest(cacheStore) {
    const active = await cacheStore.readActive();
    if (active === null) {
        throw new Error("no active version — sync first");
    }
    const raw = await cacheStore.getManifest(active.manifest_hash);
    const manifest = JSON.parse(DECODER.decode(raw));
    return manifest;
}
function lockManager() {
    return navigator.locks === undefined
        ? undefined
        : {
            request: (name, operation) => navigator.locks.request(name, operation),
        };
}
async function handle(req) {
    switch (req.kind) {
        case "sync":
            return handleSync(req);
        case "readFile":
            return handleReadFile(req);
        case "clear":
            return handleClear(req);
    }
}
self.addEventListener("message", (event) => {
    const req = event.data;
    handle(req)
        .then((response) => {
        if (response.ok && response.kind === "readFile") {
            self.postMessage(response, { transfer: [response.bytes.buffer] });
            return;
        }
        self.postMessage(response);
    })
        .catch((error) => {
        const response = {
            ok: false,
            id: req.id,
            kind: req.kind,
            error: classifyEngineError(error),
        };
        self.postMessage(response);
    });
});
//# sourceMappingURL=worker.js.map