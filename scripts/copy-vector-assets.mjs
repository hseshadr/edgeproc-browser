import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src", "vector", "sqlite", "assets");
const destination = join(root, "dist", "vector", "sqlite", "assets");

await mkdir(destination, { recursive: true });
for (const file of [
	"sqlite3.mjs",
	"sqlite3.wasm",
	"sqlite3-opfs-async-proxy.js",
	"README.md",
	"LICENSE.sqlite.md",
	"LICENSE.sqlite-vector.md",
	"THIRD_PARTY_NOTICES.md",
]) {
	await copyFile(join(source, file), join(destination, file));
}
