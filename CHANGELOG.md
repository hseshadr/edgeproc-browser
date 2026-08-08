# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A publish preflight that makes a stale `dist/` unpublishable.**
  `prepublishOnly` now runs `scripts/preflight-publish.mjs` and then the full
  gate. The script refuses outright — before anything is built or packed — if the
  tree is dirty, if `HEAD` is on no remote-tracking branch, or if there is no git
  work tree at all; then it deletes `dist/` so the gate's build cannot reuse a
  stale object. `files: ["dist"]` means the tarball *is* `dist/`, which is
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
  two); it told you to `cd errors` after cloning; and it listed the gate's steps
  in the wrong order, hiding that the build runs before the tests on purpose.

## [0.1.0] - 2026-08-06

First release. The signed-bundle sync substrate of edge-proc, extracted from
[edge-reco](https://github.com/hseshadr/edge-reco) — where it had been running in
production — and published so its three consumers stop each carrying their own copy.

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
  `EngineClient.spawn()` names a Worker file that exists, that every `exports`
  path resolves, and that nothing shipped imports `node:*`.
- `test/workflow-security.test.ts`, which fails the gate on any unpinned `uses:`
  or top-level write scope, and carries accept/reject cases so the rule itself is
  proven rather than assumed.

### Changed from the extracted source

- Relative import specifiers gained `.js` extensions, for spec-correct ESM.
  13 of the 14 modules differ from their origin in **nothing else**.
- `EngineClient.spawn()` now builds its Worker URL from `./worker.js` rather than
  `./worker.ts`. `tsc` emits that string literal verbatim, so in a published
  package the `.ts` form resolved to a file that does not exist — and nothing
  threw; the Worker simply never booted. This is the one substantive change.

### Known gaps

- `opfsStore.ts` is **excluded from the coverage gate and genuinely under-tested**
  (57% of statements). jsdom has no OPFS, so sync-access-handle contention, the
  nav-release race, and partial-write recovery are unproven by this suite. A
  real-browser tier is required before that module can carry a coverage claim.
- `0.1.0` carries **no npm provenance**. npm has no "pending publisher" state — a
  trusted publisher attaches to an existing package — so the first publish of a new
  name must be manual, and a published version is immutable. The next release will
  be a patch whose only change *is* the provenance.

### Evidence

- Gate green: 16 test files, 154 tests. Coverage 92.83% statements /
  86.23% branches / 99.04% functions / 93.77% lines.
- The `networkSentinel` guard was watched failing, not merely watched passing.
  Four mutations, each verified applied by md5 before its result was trusted and
  each judged on the vitest **exit code** rather than grepped output: dropping the
  `timeOrigin` rebase (3 failures), making `isNetworkSentinelReport` return `true`
  unconditionally (1), accepting entries of any field type (1), and observing
  without `buffered: true` (1). All four went red; the unmutated control was green;
  the file was restored byte-identical.

[Unreleased]: https://github.com/hseshadr/edgeproc-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hseshadr/edgeproc-browser/releases/tag/v0.1.0
