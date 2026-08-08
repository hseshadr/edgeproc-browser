// @vitest-environment node
//
// The publish preflight is the only thing standing between `npm publish` and a
// tarball that matches no fetchable commit. A guard nobody has watched refuse is
// not a guard, so every refusal below is driven for real: a throwaway git repo is
// built on disk in each shape the script must reject, the script is executed
// against it, and the exit code is the verdict — never grepped prose alone.
//
// The accept case matters just as much. A guard that refuses everything also
// "passes" a reject-only suite, and would quietly make releases impossible.
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PREFLIGHT = fileURLToPath(
	new URL("../scripts/preflight-publish.mjs", import.meta.url),
);

const scratch: string[] = [];

afterEach(() => {
	while (scratch.length > 0) {
		const dir = scratch.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "edgeproc-preflight-"));
	scratch.push(dir);
	return dir;
}

function git(dir: string, ...args: readonly string[]): void {
	execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/**
 * A repo shaped like this one: `dist` gitignored, one commit, clean tree. The
 * local identity and unsigned commits are forced so a contributor's global git
 * config cannot decide whether this suite passes.
 */
function repoWithOneCommit(): string {
	const dir = scratchDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "preflight@example.invalid");
	git(dir, "config", "user.name", "Preflight Test");
	git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, ".gitignore"), "dist\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** Marks HEAD as present on a remote, without needing one to exist. */
function markPushed(dir: string): void {
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
}

/** A dist/ that a real stale-build publish would have shipped verbatim. */
function staleDist(dir: string): string {
	const dist = join(dir, "dist");
	mkdirSync(dist, { recursive: true });
	const stale = join(dist, "stale.js");
	writeFileSync(stale, "export const built = 'from some other commit';\n");
	return stale;
}

function runPreflight(dir: string): { status: number | null; output: string } {
	const r = spawnSync(process.execPath, [PREFLIGHT], {
		cwd: dir,
		encoding: "utf8",
	});
	return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("publish preflight", () => {
	it("refuses when there is no git work tree to name a commit", () => {
		const { status, output } = runPreflight(scratchDir());
		expect(status).toBe(1);
		expect(output).toMatch(/not a git work tree/);
	});

	it("refuses a dirty tree, and does not touch dist on the way out", () => {
		const dir = repoWithOneCommit();
		markPushed(dir);
		const stale = staleDist(dir);
		writeFileSync(join(dir, "uncommitted.ts"), "export const x = 1;\n");

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/working tree is not clean/);
		expect(output).toContain("uncommitted.ts");
		// Refuse BEFORE mutating: a guard that half-runs is a guard that has to be
		// re-run by hand to get back to a known state.
		expect(existsSync(stale)).toBe(true);
	});

	it("refuses a commit that exists only on this machine", () => {
		const dir = repoWithOneCommit();

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/on no remote-tracking branch/);
	});

	it("accepts a clean pushed commit, and empties dist so the build is from scratch", () => {
		const dir = repoWithOneCommit();
		markPushed(dir);
		const stale = staleDist(dir);

		const { status, output } = runPreflight(dir);

		expect(status).toBe(0);
		expect(output).toMatch(/preflight OK/);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(dir, "dist"))).toBe(false);
	});
});
