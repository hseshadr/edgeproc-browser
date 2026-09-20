# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A shared browser-engine contract for multiple consumers.** Signed sync now
  supports exact nullable identity pins, whole-file and safe directory-prefix
  scopes (`[]` is catalog-only; `undefined` is all files), per-verified-chunk
  progress, progress-rearmed idle timeouts, typed Worker errors, and an explicit
  locked cache clear. Persistent storage uses OPFS as the sole content store
  with a tiny IndexedDB pointer floor, falls back to full IndexedDB when OPFS is
  unavailable, and can declaratively reuse a bounded legacy database/store/key
  layout. A real Vite fixture proves the supported consumer-owned Worker entry
  emits exactly one engine Worker. Direct browser ESM users can opt into
  `spawnEngineClient()` through the separate `@edgeproc/browser/spawn` subpath,
  keeping the root client export free of dependency-internal Worker URLs.

- **`PackedVectorIndex` for immutable signed-bundle matrices.** The
  dependency-free synchronous adapter copies and validates FLOAT32 input,
  computes exact cosine similarity with deterministic ties, exposes defensive
  row copies, and fails closed after zeroizing disposal.

- **Reproducible exact-Git-SHA installs.** `prepare` uses the package-manager
  neutral `npm run build`; registry packages remain limited to `dist/`.

- **A replaceable browser vector contract and opt-in SQLite/OPFS adapter.** The
  dependency-free `FlatVectorIndex` and the Worker-hosted SQLite adapter share
  one conformance suite. The persistent adapter statically links only SQLite
  3.53.4 and Apache-2.0 sqlite-vector 1.1.2—no FAISS and no SQLiteAI
  sync/memory/network bundle—uses exact FLOAT32 cosine search, transactional
  batches, parameterized AND filters, deterministic ID tie breaks, and explicit
  disposal. Pinned artifact hashes, a digest-pinned Docker rebuild, and packaged
  third-party notices make the WASM auditable. A real Chromium test proves OPFS
  persistence across Worker restart and zero external requests.

- **A publish preflight that makes a stale `dist/` unpublishable.**
  `prepublishOnly` now runs `scripts/preflight-publish.mjs` and then the full
  gate. The script refuses outright — before anything is built or packed — if the
  tree is dirty, if `HEAD` is neither on a remote-tracking branch nor at an exact
  local tag published unchanged to `origin`, or if there is no git work tree at
  all; then it deletes `dist/` so the gate's build cannot reuse a stale object.
  This covers both normal branch builds and GitHub Actions' shallow detached-tag
  checkout without trusting a local-only or moved tag. `files: ["dist"]` means
  the tarball *is* `dist/`, which is
  gitignored, so previously `npm publish` shipped whatever the last build left on
  disk. It nearly shipped exactly that: `dist/engine/client.js` was rebuilt three
  minutes after `#releaseWorker()` landed and two days after the only commit on
  `main`, so the compiled output carried a fix no published commit contained.
  Covered by `test/publish-preflight.test.ts`, which drives every refusal and the
  accept case against real throwaway repos.

### Fixed

- **CONTRIBUTING claimed things that were not true of this package.** It said
  coverage was enforced at 100% (`vitest.config.ts` enforces 90/90/90/85) because
  "the library is pure logic with no I/O" (its subject is OPFS, Workers and
  BroadcastChannel); it said the package has zero runtime dependencies (it has
  three); it told you to `cd errors` after cloning; and it listed the gate's steps
  in the wrong order, hiding that the build runs before the tests on purpose.

## Planned 0.1.0 (not yet published)

This is the planned first release; npm and GitHub do not yet carry a 0.1.0
package, tag, or release. The signed-bundle sync substrate of edge-proc was extracted from
[edge-reco](https://github.com/hseshadr/edge-reco) — where it had been running in
production — so its three consumers can stop each carrying their own copy after
publication.

### Added

- **Verification core** — `verifyEd25519`, `sha256Hex` (`SignatureError`);
  `canonicalBytes` for the exact bytes a signature is taken over;
  `decompressAndVerify` / `verifyPlaintext` with a bounded expansion limit
  (`IntegrityError`); `decompressBounded` over `@hpcc-js/wasm-zstd`.
- **Sync state machine** — `syncIndex` and `materializeFile`, with monotonic
  pointer enforcement (`RollbackError` on a lower or equal-sequence pointer,
  rejected *before* the manifest fetch) and structural caps (`SyncCapError`).
- **Transport** — `fetchBytes`, byte-capped while streaming and bounded by a 15s
  deadline that includes body consumption. An oversized response raises
  `ResponseTooLargeError`, which extends `IntegrityError` rather than
  `NetworkError`, so sync can never silently serve cache for one.
- **Stores** — `MemoryCacheStore` and `OpfsCacheStore`, both content-addressed
  and fail-closed on read as well as write.
- **Worker boundary** — `EngineClient` plus typed failures `WorkerCrashError` and
  `WorkerTimeoutError`. A Worker that dies during init never posts a reply; without
  these, every in-flight promise hangs forever.
- **`installNetworkSentinel`** — the module this package exists to share. Each
  browsing context keeps its own resource-timing timeline, so a window-side
  `PerformanceObserver` cannot see anything a Worker fetches. The sentinel observes
  a Worker's own timeline and broadcasts it on a same-origin `BroadcastChannel`,
  carrying EPOCH timestamps (the one clock every context shares) so a reader can
  rebase them. `isNetworkSentinelReport` validates shape before counting, because
  same-origin is not the same as trusted. It degrades to a no-op rather than
  throwing where `PerformanceObserver` or `BroadcastChannel` is missing.
- `test/dist-contract.test.ts`, which asserts against **real build output** that
  the opt-in `spawnEngineClient()` names a Worker file that exists, that the
  root client contains no Worker URL, that every `exports` path resolves, and
  that nothing shipped imports `node:*`.
- `test/workflow-security.test.ts`, which fails the gate on any unpinned `uses:`
  or top-level write scope, and carries accept/reject cases so the rule itself is
  proven rather than assumed.

### Changed from the extracted source

- Relative import specifiers gained `.js` extensions for spec-correct ESM.
- The consumer-independent persistence, scoped-sync, progress, typed-error,
  locked-clear, and packed-vector contracts now live here instead of remaining
  vendored in product repositories.
- Worker spawning moved out of `EngineClient` and into the opt-in
  `@edgeproc/browser/spawn` subpath. The supported Vite path remains a
  consumer-owned one-line Worker entry importing `@edgeproc/browser/worker`.

### Known gaps

- `opfsStore.ts` remains excluded from the numeric jsdom coverage gate because
  jsdom has no OPFS implementation. An in-memory OPFS double covers dual-slot
  promotion, corrupt/zero-byte cleanup, and pre-write handle contention; the
  Chromium tier proves real OPFS persistence.
- The first `0.1.0` publish would carry **no npm provenance**. npm has no
  "pending publisher" state — a trusted publisher attaches to an existing
  package — so the first publish of a new name must be manual, and a published
  version is immutable. If 0.1.0 is bootstrapped this way, the next release must
  be a provenance-bearing patch.

### Evidence

- Gate green: 27 test files, 258 tests. Coverage 92.99% statements / 87.12%
  branches / 97.92% functions / 93.86% lines. The real Chromium
  SQLite/OPFS Worker persistence test also passes.
- The `networkSentinel` guard was watched failing, not merely watched passing.
  Four mutations, each verified applied by md5 before its result was trusted and
  each judged on the vitest **exit code** rather than grepped output: dropping the
  `timeOrigin` rebase (3 failures), making `isNetworkSentinelReport` return `true`
  unconditionally (1), accepting entries of any field type (1), and observing
  without `buffered: true` (1). All four went red; the unmutated control was green;
  the file was restored byte-identical.
