import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "test/browser",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	use: {
		baseURL: "http://127.0.0.1:4177",
		headless: true,
	},
	webServer: {
		command: "vite --host 127.0.0.1 --port 4177 --strictPort",
		url: "http://127.0.0.1:4177/test/browser/fixture.html",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
