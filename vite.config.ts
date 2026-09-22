import { defineConfig } from "vite";

// SQLite's official multi-tab opfs-wl VFS requires SharedArrayBuffer. These
// headers make the real-browser fixture match the documented deployment
// contract instead of testing a capability consumers would not have.
export default defineConfig({
	server: {
		headers: {
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
		},
	},
});
