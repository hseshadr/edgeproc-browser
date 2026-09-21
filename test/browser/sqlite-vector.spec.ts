import { expect, test } from "@playwright/test";

test("persists exact vector search in OPFS across a Worker restart", async ({
	page,
}) => {
	const externalRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.hostname !== "127.0.0.1") {
			externalRequests.push(request.url());
		}
	});
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const result = await page.evaluate(async (name) => {
		return window.runSqliteVectorProof(name);
	}, `playwright-${crypto.randomUUID()}`);

	expect(result).toEqual({
		runtime: {
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			vectorBackend: "CPU",
			bundledExtensions: ["vector_version"],
		},
		firstNearest: "closest",
		deletedWhere: 1,
		reopenedNearest: "closest",
		reopenedCount: 1,
		cleared: 1,
	});
	expect(externalRequests).toEqual([]);
});
