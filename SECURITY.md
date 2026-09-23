# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately in one of two ways:

1. GitHub's private reporting — go to the
   [Security tab](https://github.com/hseshadr/edgeproc-browser/security/advisories/new)
   and open a draft advisory. This is preferred; it keeps the discussion in the
   repo and lets us issue a CVE if one is warranted.
2. Email `harish.seshadri@gmail.com` with `SECURITY` in the subject.

Please include what you can: the version, a description of the problem, and the
smallest input that reproduces it.

We aim to acknowledge a report within 5 working days and to ship a fix or an
explanation of why it is not a vulnerability within 30 days.

## Supported versions

This project is pre-1.0. Only the latest published version gets fixes. Once 1.0
ships, the latest minor of the current major will be supported as well.

## Threat model

`@edgeproc/browser` deliberately performs network and browser-storage I/O. Its
security boundary is a signed, monotonic pointer: the Worker fetches a pinned
public key without HTTP-cache reuse, verifies the pointer, content-addresses the
manifest, bounds compressed and expanded bytes, verifies every chunk and
reassembled file, then promotes last. Invalid bytes never become a degraded
result.

Important integration rules:

- Pin the expected bundle and channel when the publisher has those identities.
  `undefined` deliberately skips a pin; `null` requires a legacy absent/null
  field exactly.
- Treat the configured public-key URL as a trust root. Serve it over HTTPS and
  control it separately from mutable bundle content.
- Cache names and legacy IndexedDB layouts are local identifiers, not secrets.
  Layout input is bounded and cannot select arbitrary code or callbacks.
- OPFS content and the IndexedDB rollback pointer are untrusted durable state.
  They are revalidated before use; equal-sequence disagreement fails closed.
- The stored active pointer is the anti-rollback floor even when the currently
  pinned key cannot verify it (after a key rotation, or a swapped key), so a key
  change never resets the floor: an older release re-signed by a new key is
  refused as a rollback. The floor only refuses; the cached bundle is served
  offline only under a signature the current key verifies. A key rotation must
  therefore keep the publisher's `sequence` increasing. Rotation is a
  coordinated re-sign plus an app release shipping the new public key; there is
  no keyring, revocation list, or pointer expiry yet (see edge-proc's
  `docs/OPERATIONS.md`).
- Worker error messages can include URLs or producer-controlled identifiers.
  Do not render them as HTML and do not place secrets in bundle paths or URLs.
- The network sentinel is evidence about requests, not an access-control
  mechanism. Same-origin channel messages are shape-checked but are not treated
  as authenticated actors.

Runtime dependencies are `@noble/ed25519`, `@hpcc-js/wasm-zstd`, and
`idb-keyval`. The optional SQLite vector subpath ships pinned local WASM assets
and does not load code from a CDN.
