#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const status = execFileSync(
	"git",
	["status", "--porcelain", "--untracked-files=all", "--", "dist"],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();

if (status !== "") {
	process.stderr.write(
		`dist/ is not the deterministic output committed for this source:\n${status}\n`,
	);
	process.exit(1);
}

process.stdout.write("committed dist/ matches a clean build\n");
