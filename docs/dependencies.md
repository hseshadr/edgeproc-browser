# Runtime dependency provenance

`@edgeproc/browser` keeps the browser substrate small and auditable:

| Package | Pinned range | Purpose | License |
|---|---:|---|---|
| `@noble/ed25519` | `^3.1.0` | Ed25519 verification | MIT |
| `@hpcc-js/wasm-zstd` | `^1.15.0` | bounded zstd decompression | Apache-2.0 |
| `idb-keyval` | `^6.3.0` | small IndexedDB transaction helpers | Apache-2.0 |

The optional `@edgeproc/browser/vector/sqlite` subpath carries its own exact
SQLite/sqlite-vector versions, artifact hashes, rebuild recipe, and license
texts in `src/vector/sqlite/assets/`.
