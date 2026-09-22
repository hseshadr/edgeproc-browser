import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = dirname(import.meta.dirname);
const SCRIPT = join(ROOT, "scripts", "copy-vector-assets.mjs");
const ASSETS = [
	"sqlite3.mjs",
	"sqlite3.wasm",
	"sqlite3-opfs-async-proxy.js",
	"README.md",
	"LICENSE.sqlite.md",
	"LICENSE.sqlite-vector.md",
	"THIRD_PARTY_NOTICES.md",
] as const;

const temporaryRoots: Array<string> = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function preparedGitDependency(): string {
	const root = mkdtempSync(join(tmpdir(), "edgeproc-git-prepare-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "src", "vector", "sqlite", "assets"), {
		recursive: true,
	});
	mkdirSync(join(root, "dist", "vector", "sqlite", "assets"), {
		recursive: true,
	});
	copyFileSync(SCRIPT, join(root, "scripts", "copy-vector-assets.mjs"));
	for (const asset of ASSETS) {
		const source = join(root, "src", "vector", "sqlite", "assets", asset);
		const destination = join(root, "dist", "vector", "sqlite", "assets", asset);
		writeFileSync(source, `fixture:${asset}`);
		linkSync(source, destination);
	}
	return root;
}

describe("copy-vector-assets Git dependency prepare", () => {
	it("accepts pnpm hard links when committed dist already matches src", () => {
		const root = preparedGitDependency();

		expect(() =>
			execFileSync(process.execPath, [
				join(root, "scripts", "copy-vector-assets.mjs"),
			]),
		).not.toThrow();
		expect(
			readFileSync(
				join(root, "dist", "vector", "sqlite", "assets", "sqlite3.mjs"),
				"utf8",
			),
		).toBe("fixture:sqlite3.mjs");
	});
});
