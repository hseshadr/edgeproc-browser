// @vitest-environment node
//
// README contract: the first screen stays readable, true, and wired to real
// files. This is the portfolio README template's contract test. It is
// deliberately dumb — string and regex checks only, no markdown parser —
// because its job is to stop the first screen drifting (tagline vs package
// metadata, badge creep, a missing label, a dead link), not to judge prose.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const PACKAGE = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
	description: string;
};
const TAGLINE_LIMIT = 120;
const BADGE_LIMIT = 4;
const REQUIRED_LABELS = [
	"**What it does**",
	"**Who it's for**",
	"**What stays on your device / what leaves it**",
	"**Runs on**",
	"**Not for**",
	"**Status**",
];
const ARCHITECTURE_MAP = "docs/architecture/index.html";
const ARCHITECTURE_SOURCE = "docs/architecture/runtime.architecture.json";
// [text](target) — the target stops at whitespace or ")"; a "title" is ignored.
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const before = (heading: string): string => README.split(heading)[0] ?? "";
const firstScreen = before("## Try it in 60 seconds");
const links = [...README.matchAll(LINK)].map(([, text = "", target = ""]) => ({
	text,
	target,
}));
const relativeTargets = [
	...new Set(
		links
			.map(({ target }) => target)
			.filter(
				(target) =>
					!/^[a-z][a-z0-9+.-]*:/.test(target) && !target.startsWith("#"),
			)
			.map((target) => target.split("#")[0] ?? target),
	),
].sort();

describe("README contract", () => {
	it("opens with the package name", () => {
		expect(README.split("\n")[0]).toBe("# @edgeproc/browser");
	});

	it("has a short tagline equal to the package description", () => {
		const tagline = README.split("\n")
			.slice(1)
			.map((line) => line.trim())
			.find((line) => line !== "" && !line.startsWith("[!["));
		expect(tagline).toBe(PACKAGE.description);
		expect(PACKAGE.description.length).toBeLessThanOrEqual(TAGLINE_LIMIT);
	});

	it("carries at most four badges before At a glance", () => {
		const badges = before("## At a glance").split("[![").length - 1;
		expect(badges).toBeLessThanOrEqual(BADGE_LIMIT);
	});

	it.each(REQUIRED_LABELS)("has the %s label on the first screen", (label) => {
		expect(firstScreen).toContain(label);
	});

	it("puts Try it in 60 seconds before How it works", () => {
		const tryIt = README.indexOf("## Try it in 60 seconds");
		expect(tryIt).toBeGreaterThan(-1);
		expect(tryIt).toBeLessThan(README.indexOf("## How it works"));
	});

	it("captions the hero before the example", () => {
		expect(firstScreen).toContain("Real output of the example below");
	});

	it("links the interactive architecture map and its source exists", () => {
		const map = links.filter(({ text }) =>
			text.includes("Explore the interactive architecture map"),
		);
		expect(map.map(({ target }) => target)).toEqual([ARCHITECTURE_MAP]);
		expect(existsSync(join(ROOT, ARCHITECTURE_SOURCE))).toBe(true);
	});

	it("finds relative links to check", () => {
		expect(relativeTargets).toContain(ARCHITECTURE_MAP);
	});

	it.each(relativeTargets)("resolves the relative link %s", (target) => {
		expect(existsSync(join(ROOT, target))).toBe(true);
	});
});
