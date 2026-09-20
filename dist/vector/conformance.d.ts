import type { VectorIndexFactory } from "./types.js";
/**
 * Exercise the behavior every VectorIndex adapter must share.
 *
 * This intentionally has no test-runner dependency. Adapter packages can call
 * it from Vitest, Playwright, or a browser smoke test and receive one error with
 * each broken contract named.
 */
export declare function assertVectorIndexConformance(factory: VectorIndexFactory): Promise<void>;
//# sourceMappingURL=conformance.d.ts.map