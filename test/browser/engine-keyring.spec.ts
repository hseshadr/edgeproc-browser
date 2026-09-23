import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, test } from "@playwright/test";

const CATALOG = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
	"catalog",
);

test("the built engine Worker verifies under a raw key, a keyring, and refuses a revoked signer", async ({
	page,
}) => {
	const externalRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol !== "blob:" && url.hostname !== "127.0.0.1") {
			externalRequests.push(request.url());
		}
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let originRequests = 0;
	await page.context().route("**/bundle-origin/**", async (route) => {
		originRequests += 1;
		const relative = normalize(
			new URL(route.request().url()).pathname.replace("/bundle-origin/", ""),
		);
		await route.fulfill({
			status: 200,
			headers: { "Cross-Origin-Resource-Policy": "same-origin" },
			body: readFileSync(join(CATALOG, relative)),
		});
	});
	await page.goto("/test/browser/engine-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const result = await page.evaluate(
		(namespace) => window.runEngineKeyringProof(namespace),
		`playwright-${crypto.randomUUID()}`,
	);

	expect(result.legacyVersion).toBe("v1");
	expect(result.legacyMetaBytes).toBeGreaterThan(0);
	expect(result.keyringVersion).toBe("v1");
	expect(result.keyringChunksReused).toBeGreaterThan(0);
	expect(result.revokedCode).toBe("integrity");
	expect(result.revokedPromotedNothing).toBe(true);
	expect(originRequests).toBeGreaterThan(0);
	expect(externalRequests).toEqual([]);
	expect(errors).toEqual([]);
});
