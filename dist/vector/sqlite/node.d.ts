import type { VectorIndexOptions } from "../types.js";
import { SqliteDatabaseVectorIndex } from "./database.js";
/** Open the pinned SQLite/sqlite-vector WASM runtime in an in-memory Node DB. */
export declare function createNodeSqliteVectorIndex(options: VectorIndexOptions): Promise<SqliteDatabaseVectorIndex>;
//# sourceMappingURL=node.d.ts.map