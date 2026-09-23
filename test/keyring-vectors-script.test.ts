import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = dirname(import.meta.dirname);
const SCRIPT = join(ROOT, "scripts", "generate-keyring-vectors.mjs");
const VECTORS = join(
	ROOT,
	"src",
	"engine",
	"__fixtures__",
	"keyring_vectors.json",
);

describe("keyring vector generator", () => {
	it("reproduces the committed vectors exactly from fixed seeds", () => {
		const digest = execFileSync(process.execPath, [SCRIPT, "--check"], {
			cwd: ROOT,
			encoding: "utf8",
		}).trim();
		expect(digest).toBe(
			createHash("sha256").update(readFileSync(VECTORS)).digest("hex"),
		);
	});
});
