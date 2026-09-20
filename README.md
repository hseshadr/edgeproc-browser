# @edgeproc/browser

**Pull a signed, content-addressed bundle into a browser and prove it arrived intact — then run it in a Worker whose network traffic you can actually see.**

Fetch under a byte cap. Verify an ed25519 signature over canonical JSON. Bound and verify every zstd decompression. Store chunks content-addressed in OPFS. Reassemble files. Do all of it in a Web Worker, and — this is the part nobody else does — let the main thread *observe that Worker's network activity*, so "no backend calls" is a measurement instead of a promise.

Zero framework dependencies. Two runtime deps (`@noble/ed25519`,
`@hpcc-js/wasm-zstd`), plus an opt-in, self-hosted SQLite vector runtime under
the separate `@edgeproc/browser/vector/sqlite` export.

## TL;DR

- Verify every downloaded byte before use, including bounded zstd expansion.
- Cache content-addressed chunks locally and reject rollback or equivocation.
- Observe Worker network activity from the context where it actually happens.
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

The planned package API looks like this after the package is published:

```ts
import { EngineClient, installNetworkSentinel } from "@edgeproc/browser";

// --- in your Worker entry, one line, once ---
installNetworkSentinel("my-worker");

// --- on the main thread ---
const client = EngineClient.spawn();
const result = await client.sync(bundleBaseUrl, pubkeyUrl, "my-bundle", "stable");
const bytes = await client.readFile("catalog_meta.json"); // verified or it throws
```

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
await index.dispose();
```

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
The build recipe, exact source pins, hashes, and licenses live beside the
packaged assets in `src/vector/sqlite/assets/README.md`.

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

- **`opfsStore.ts` is not covered by this package's test suite** (57% of statements, and excluded from the coverage gate). jsdom has no OPFS implementation, so sync-access-handle contention, the nav-release race, and partial-write recovery are **unproven here**. They are exercised downstream against a real browser. This package needs its own real-browser tier before that module can carry a coverage claim.
- **`worker.ts` is excluded too**, for a different reason: it is a top-level side effect, so importing it under jsdom would run it, not test it.
- **The SQLite vector Worker is excluded from jsdom coverage for the same
  reason.** Its real Chromium test opens OPFS, verifies extension provenance,
  queries, disposes, reopens in a new Worker, and proves the records persisted
  without any external request.
- Everything else clears the project floor — 95.92% statements, 92.40% branches, 100% functions, 96.64% lines.

## Consuming this package

It builds to ESM with fully-specified relative imports, so it works in Node and in every bundler. It is nonetheless **browser-only at runtime**: modules reference `BroadcastChannel`, `PerformanceObserver`, `navigator.storage`, and `WorkerGlobalScope`. Import it in bare Node and it will type-check and load, then fail the moment it touches a browser global. The exception is the pure-logic core (`crypto`, `canonical`, `integrity`, `zstd`, `sync` with `MemoryCacheStore`), which runs anywhere — that is what the quickstart exercises.

`EngineClient.spawn()` constructs the Worker from `new URL("./worker.js", import.meta.url)`. Bundlers need that literal to stay statically analyzable; do not wrap it.

## Architecture

Explore the [interactive runtime map](docs/architecture/index.html).

## Provenance

This code was extracted from [edge-reco](https://github.com/hseshadr/edge-reco), where it had been running in production, rather than written fresh. The extraction is verifiable: **13 of its 14 modules differ from their origin only in import specifiers** (`./x` → `./x.js`, required for spec-correct ESM). The single substantive change is in `EngineClient.spawn()`, which now names `./worker.js` — the file as it exists in the package artefact — and is guarded by `test/dist-contract.test.ts` against real build output.

`engine/crypto.ts` is byte-identical (`md5 864f84b8bed8660362489cf92d934e06`) to the copy shipping in all three consumer repos today.

## Development

```bash
pnpm install
pnpm gate      # lint -> typecheck -> build -> test (exactly what CI runs)
pnpm test:browser # real Chromium: sqlite-vector + Worker + OPFS reopen
```

The build runs *before* the tests on purpose: `files: ["dist"]` means consumers get only build output, so `test/dist-contract.test.ts` inspects the real artefact. A claim that holds in `src/` and fails in `dist/` is invisible to every source-level test.

## License

MIT
