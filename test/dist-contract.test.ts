// @vitest-environment node
//
// The published artefact is not the source tree, and the difference is where
// this package can lie. `files: ["dist"]` means consumers get ONLY the build
// output, so anything that is true of src/ and false of dist/ is a defect that
// no source-level test can see.
//
// Two such claims exist and both are checked here against real build output:
//
//   1. EngineClient.spawn() resolves a Worker URL from a plain string literal.
//      tsc emits that literal verbatim, so it names `./worker.js` — a file that
//      exists only AFTER a build. Get it wrong and nothing throws: the URL
//      resolves to a 404 and the Worker silently never boots.
//
//   2. Every path in package.json `exports` points at a file that exists.
//
// This is why the gate runs `build` BEFORE `test`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

const built = existsSync(DIST);
// A guard that silently skips is a guard that never guards. If dist is missing
// the gate ran out of order — say so loudly rather than reporting green.
describe("published artefact contract", () => {
	it("has build output to inspect (run `pnpm build` first)", () => {
		expect(built).toBe(true);
	});

	it("EngineClient.spawn points at a Worker file that actually exists", () => {
		const client = join(DIST, "engine", "client.js");
		expect(existsSync(client)).toBe(true);
		const source = readFileSync(client, "utf8");
		const match = source.match(
			/new URL\(\s*"(\.[^"]+)"\s*,\s*import\.meta\.url/,
		);
		expect(match, "spawn() must build its Worker URL from a literal").not.toBe(
			null,
		);
		const referenced = match?.[1] ?? "";
		expect(referenced).toBe("./worker.js");
		// The real assertion: resolve it the way the browser will.
		const onDisk = resolve(dirname(client), referenced);
		expect(
			existsSync(onDisk),
			`spawn() references ${referenced}, which does not exist at ${onDisk}`,
		).toBe(true);
	});

	it("every package.json export resolves to a real file", () => {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		) as {
			exports: Record<string, Record<string, string> | string>;
		};
		const targets: string[] = [];
		for (const entry of Object.values(pkg.exports)) {
			if (typeof entry === "string") {
				targets.push(entry);
			} else {
				targets.push(...Object.values(entry));
			}
		}
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			const onDisk = join(ROOT, target);
			expect(existsSync(onDisk), `exports -> ${target} is missing`).toBe(true);
		}
	});

	it("ships no node: import in anything a browser will load", () => {
		// The fixture loader reads node:fs. It is test-only and tsconfig.build
		// excludes it; this proves the exclusion held rather than trusting it.
		const walk = (dir: string): string[] => {
			const { readdirSync } = require("node:fs") as typeof import("node:fs");
			return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = join(dir, entry.name);
				return entry.isDirectory()
					? walk(full)
					: full.endsWith(".js")
						? [full]
						: [];
			});
		};
		const offenders = walk(DIST).filter((file) =>
			/from\s*"node:|require\("node:/.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
