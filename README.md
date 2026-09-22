# @edgeproc/browser

**Pull a signed, content-addressed bundle into a browser and prove it arrived intact — then run it in a Worker whose network traffic you can actually see.**

Fetch under a byte cap. Verify an ed25519 signature over canonical JSON. Bound and verify every zstd decompression. Store chunks content-addressed in OPFS. Reassemble files. Do all of it in a Web Worker, and — this is the part nobody else does — let the main thread *observe that Worker's network activity*, so "no backend calls" is a measurement instead of a promise.

Zero framework dependencies. Three small runtime deps (`@noble/ed25519`,
`@hpcc-js/wasm-zstd`, and `idb-keyval`), plus one opt-in, self-hosted SQLite
runtime shared by the separate `@edgeproc/browser/sqlite` application-state and
`@edgeproc/browser/vector/sqlite` vector exports.

## TL;DR

- Verify every downloaded byte before use, including bounded zstd expansion.
- Cache content-addressed chunks locally and reject rollback or equivocation.
- Observe Worker network activity from the context where it actually happens.
- Keep portable application state in one real SQLite file, with atomic CAS
  writes and validated backup replacement instead of raw SQL.
- **Status:** source preview. `@edgeproc/browser` is not published to npm yet.

## The problem, in one line

You want to ship data to a browser and have the tab verify it rather than trust the server — and you want to be able to *prove* the tab then stopped talking to the network.

Both halves are harder than they look. The first is a pile of fiddly, security-critical plumbing (canonical bytes, monotonic version pointers, decompression bombs, partial writes) that every local-first app rewrites badly. The second is a trap: **every browsing context keeps its own resource-timing timeline**, so a `PerformanceObserver` on the window sees *nothing* a Worker fetches. A "0 backend calls" counter built the obvious way reads zero exactly when it matters.

## Run it locally

A real signed bundle, verified end to end, with no network and no browser. This
is the supported path until the first npm release:

```bash
git clone https://github.com/hseshadr/edgeproc-browser && cd edgeproc-browser
corepack enable
pnpm install --frozen-lockfile
pnpm demo
```

```
1. syncing the signed bundle into a content-addressed store...
   version        v1
   manifest       81a71fb0ba2f01ed...
   chunks fetched 783, reused 0
   http requests  785

2. reassembling 728 files, each verified...
   all 728 files match their signed sha256.

3. a second sync over the primed store refetches nothing:
   chunks fetched 0 (reused 783)

4. fail-closed check — same bundle, one bit flipped in the key:
   rejected with SignatureError — fail-closed holds.
```

That is [`examples/quickstart.mjs`](./examples/quickstart.mjs), running against the real signed bundle committed in this repo. The transport is injected, so "no network" is structural rather than asserted.

With Vite, keep the Worker entry in consumer source so the bundler owns its URL:

```ts
// src/edgeproc.worker.ts
import "@edgeproc/browser/worker";
```

```ts
// main thread
import { EngineClient } from "@edgeproc/browser";
import EdgeProcWorker from "./edgeproc.worker?worker";

const client = new EngineClient(new EdgeProcWorker(), { idleTimeoutMs: 60_000 });
const result = await client.sync(bundleBaseUrl, pubkeyUrl, {
  expectedBundleId: "my-bundle",
  expectedChannel: "stable",
  wantedPaths: ["catalog_meta.json", "images/"],
  onProgress: ({ phase }) => renderPhase(phase),
});

const bytes = await client.readFile("catalog_meta.json"); // verified or it throws
await client.clear(); // same cross-tab lock as sync/read
```

`wantedPaths: undefined` syncs every signed file. `wantedPaths: []` verifies and
promotes only the signed pointer and manifest, so an application can inspect a
catalog first and fetch a selected directory later. Every verified chunk emits
progress and re-arms the client's idle watchdog.

Chunk transport failures classified as `NetworkError` receive six bounded
attempts with exponential jitter (9 seconds maximum backoff). Integrity,
signature, storage, and rollback failures are verdicts and are never retried.

To count what a Worker actually fetched, listen on the sentinel channel:

```ts
import {
  NETWORK_SENTINEL_CHANNEL,
  isNetworkSentinelReport,
} from "@edgeproc/browser";

const channel = new BroadcastChannel(NETWORK_SENTINEL_CHANNEL);
channel.onmessage = (event) => {
  if (!isNetworkSentinelReport(event.data)) return; // same-origin != trusted
  // event.data.entries carry EPOCH timestamps, comparable across contexts
};
```

## Semantic similarity without FAISS

The vector API is an adapter seam, not a ranking framework. Use the tiny exact
in-memory adapter for bounded datasets, or opt into SQLite + OPFS when the index
must survive a reload:

```ts
import { createSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite";

const index = await createSqliteVectorIndex({
  name: "my-catalog",
  dimension: 384,
});

await index.insert([{ id: "sku-1", vector: embedding, metadata: { tenant: "a" } }]);
const nearest = await index.search(query, 10, { tenant: "a" });
const candidates = await index.searchByIds(query, candidateIds); // one exact batch score
await index.deleteWhere({ tenant: "a" }); // requires a non-empty metadata scope
await index.clear(); // exact count returned; removes every local vector
await index.dispose();
```

## Portable application state without raw SQL

`@edgeproc/browser/sqlite` is a small application-state Lego over the same
pinned SQLite 3.53.4 Worker and OPFS runtime. Values are bytes, so the consumer
owns its JSON/MessagePack/Protobuf codec while this package owns durability,
transactions, schema epochs, and portable database files:

```ts
import { createSqliteStateStore } from "@edgeproc/browser/sqlite";

const state = await createSqliteStateStore({
  name: "my-app",
  initialSchemaVersion: 1,
});

const encoded = new TextEncoder().encode(JSON.stringify({ theme: "dark" }));
const write = await state.put("settings", "appearance", encoded);

// One transaction and one epoch for related changes. expectedEpoch is CAS:
// a stale writer fails with SqliteStateConflictError and writes nothing.
await state.batch(
  [
    { type: "put", namespace: "profiles", key: "primary", value: profileBytes },
    { type: "delete", namespace: "drafts", key: "profile" },
  ],
  { expectedEpoch: write.epoch },
);

const backup = await state.exportBytes(); // actual application/x-sqlite3 bytes
const staged = await state.stageImport(backup); // header, identity, schema, integrity
await state.commitImport(staged.stageId, {
  expectedEpoch: (await state.runtimeInfo()).epoch,
}); // one transaction replaces the state table

await state.dispose();
```

The public API has no `exec()` or query-string escape hatch. `get`, bounded
`list`, `put`, `delete`, `batch`, `migrate`, `reset`, integrity, export, and
staged import are the complete contract. An import never mutates live state
until commit; commit rechecks the epoch and replaces rows transactionally.

Persistent state uses SQLite 3.53.4's official `opfs-wl` VFS. Its SQLite file
locks are backed by browser Web Locks, so multiple tabs/Workers can safely open
the same store while SQLite serializes their transactions. The state Worker
also takes one store-scoped Web Lock before reading the CAS epoch and beginning
a mutation; without that outer lock, two SQLite connections can both validate
the same epoch before either commits. A tab writing from an old epoch gets
`SqliteStateConflictError` and must reload and deliberately reconcile. If
`opfs-wl` is unavailable, opening fails instead of silently downgrading to
unsafe shared ownership. Memory mode remains isolated per Worker. `opfs-wl`
requires a cross-origin-isolated page: serve COOP
`same-origin` and COEP `require-corp` (or a compatible `credentialless` policy),
then verify every cross-origin asset remains loadable. See
[the state-store contract](docs/sqlite-state.md) for migrations, backup
semantics, deployment headers, and ownership details.

This path uses SQLite 3.53.4 plus only the Apache-2.0 sqlite-vector 1.1.2
extension, statically linked into a 934,257-byte WASM file. It does **not** ship
FAISS, SQLiteAI sync/memory/network modules, an embedding model, or a backend.
Search is exact FLOAT32 cosine distance; filters are parameterized equality
predicates ANDed together. SQLite runs in a dedicated Worker and persistent mode
uses the OPFS SAH-pool VFS. One index is single-owner: concurrent tabs receive
an actionable open error after a bounded retry, rather than silently sharing a
synchronous access handle.

For ephemeral or small catalogs, import `FlatVectorIndex` from
`@edgeproc/browser/vector`; it has the same contract and no WASM startup cost.
For an immutable FLOAT32 matrix already authenticated by a signed bundle, use
the synchronous `PackedVectorIndex`: it copies and validates the matrix, computes
exact cosine similarity without another dependency, preserves producer order on
ties, and zeroizes its owned storage on disposal.
The build recipe, exact source pins, hashes, and licenses live beside the
packaged assets in `src/vector/sqlite/assets/README.md`.

For a Node recall or evaluation job that must use the same pinned SQLite and
sqlite-vector runtime—not a JavaScript cosine fallback—use the explicit
Node-only entrypoint. It is in-memory by design and never changes browser
bundle behavior:

```ts
import { createNodeSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite/node";

const index = await createNodeSqliteVectorIndex({ name: "recall-eval", dimension: 384 });
// insert/search/searchByIds/deleteWhere/clear have the same VectorIndex contract.
await index.dispose();
```

## The invariant: fail closed

An unverifiable byte is not a degraded byte, it is a rejected one. Every path that cannot prove integrity throws rather than returning something a caller might use:

| Failure | Error |
|---|---|
| signature does not verify | `SignatureError` |
| chunk hash ≠ content address | `IntegrityError` |
| decompressed size ≠ signed size | `IntegrityError` |
| response past its byte cap | `ResponseTooLargeError` (an `IntegrityError`, deliberately — sync must never fall back to cache for it) |
| pointer sequence went backwards, or forked at equal sequence | `RollbackError` |
| bundle exceeds a structural cap | `SyncCapError` |
| Worker died before replying | `WorkerCrashError` |
| Worker went silent | `WorkerTimeoutError` |
| Worker operation failed | `EngineOperationError` with `integrity`, `rollback`, `network`, `storage`, or `internal` code |

A network outage is the *only* condition that may serve cache, and it is a distinct type (`NetworkError`) for exactly that reason.

## What is deliberately NOT here

This package is the substrate, not a product. It knows how to get bytes into a tab intact and nothing about what they mean. Kept out on purpose:

- **Domain ranking / recommendation.** The generic vector seam lives here;
  product features and ranking policy remain in
  [edge-reco](https://github.com/hseshadr/edge-reco).
- **Sanctions screening / name matching.** That is [aml-filter](https://github.com/hseshadr/aml-filter)'s, and it lives there.
- **The composition root.** Whatever wires this substrate to *your* domain is yours to own — that is the seam that keeps this package a dependency rather than a framework.
- **Embedding models.** `@huggingface/transformers` is a heavyweight, model-specific dependency; it does not belong in a package this low.

The rule: if a module needs to know what the bundle *contains*, it does not belong here.

## Known gaps

Stated plainly, because an unstated gap is a lie by omission:

- **`opfsStore.ts` is excluded from the numeric jsdom coverage gate.** Its
  in-memory OPFS double covers dual-slot promotion, zero-byte cleanup,
  corruption recovery, and pre-write handle contention; real sync-access-handle
  behavior is exercised in the Chromium tier.
- **`worker.ts` is excluded too**, for a different reason: it is a top-level side effect, so importing it under jsdom would run it, not test it.
- **The SQLite Workers are excluded from jsdom coverage for the same reason.**
  Real Chromium opens OPFS, verifies vector extension provenance and restart
  persistence, then exercises application-state export/import, simultaneous
  Worker visibility, a competing CAS write, reload persistence, and zero
  external requests.
- Everything counted clears the project floor: 92.87% statements, 86.32%
  branches, 96.84% functions, and 93.73% lines (284 tests at this change).

## Consuming this package

It builds to ESM with fully-specified relative imports, so it works in Node and in every bundler. It is nonetheless **browser-only at runtime**: modules reference `BroadcastChannel`, `PerformanceObserver`, `navigator.storage`, and `WorkerGlobalScope`. Import it in bare Node and it will type-check and load, then fail the moment it touches a browser global. The exception is the pure-logic core (`crypto`, `canonical`, `integrity`, `zstd`, `sync` with `MemoryCacheStore`), which runs anywhere — that is what the quickstart exercises.

Persistent storage writes new content to OPFS and keeps only the small active
pointer rollback floor in IndexedDB. Reads can reuse verified legacy content
from either store without duplicating new payloads, and full IndexedDB storage
is used when OPFS is unavailable. Consumers with an existing cache can declare its
database, object-store, and `:` or `/` key separator through
`indexedDbLayout`, avoiding a duplicate migration layer. Names are bounded and
validated.

The root `EngineClient` export intentionally contains no Worker URL, so Vite
does not emit an unused duplicate Worker beside the consumer-owned entry shown
above. Direct, unbundled browser ESM deployments can opt into the separate
spawn helper:

```ts
import { spawnEngineClient } from "@edgeproc/browser/spawn";

const client = spawnEngineClient({ idleTimeoutMs: 60_000 });
```

`test/vite-consumer.test.ts` builds the recommended public API through Vite and
proves that exactly one engine Worker asset is emitted.

Exact Git-SHA installs are supported before the npm bootstrap. Deterministic
`dist/` output is committed so clients such as Bun that do not run Git-package
lifecycle scripts still work; npm and pnpm also rebuild it through
`prepare: npm run build`. The gate refuses when a clean build differs from the
committed output, while registry tarballs continue to contain only `dist/`.

## Architecture

Explore the [interactive runtime map](docs/architecture/index.html).

## Provenance

The original signed-bundle engine was extracted from
[edge-reco](https://github.com/hseshadr/edge-reco), where it had already run in
production. The shared package now also carries the consumer-independent
persistence, scoped-sync, progress, typed-error, and packed-vector contracts;
domain catalog selection and result-shape adapters remain in consumers.

## Development

```bash
pnpm install
pnpm gate      # lint -> typecheck -> build -> test (exactly what CI runs)
pnpm test:browser # real Chromium: sqlite-vector + Worker + OPFS reopen
```

The build runs *before* the tests on purpose: `files: ["dist"]` means consumers get only build output, so the gate verifies the committed artifact is fresh and `test/dist-contract.test.ts` loads its public exports with native Node ESM. A claim that holds in `src/` and fails in `dist/` is invisible to every source-level test.

## License

MIT
