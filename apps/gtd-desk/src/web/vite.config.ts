import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = process.env["NG_DESK_PORT"] || "8790";
const apiHost = process.env["NG_DESK_HOST"] && process.env["NG_DESK_HOST"] !== "0.0.0.0" ? process.env["NG_DESK_HOST"] : "127.0.0.1";
const target = `http://${apiHost.includes(":") ? `[${apiHost}]` : apiHost}:${apiPort}`;

// The server serves dist/web with an index fallback; in development Vite serves the client and forwards the API.
export default defineConfig({
  root,
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(root, "../../dist/web"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env["NG_DESK_WEB_PORT"] || 5173),
    strictPort: false,
    proxy: {
      // Anchored patterns: a plain "/api" prefix would also swallow the client's own module "/api.ts".
      // The SSE stream needs no special handling: the proxy streams responses as they arrive.
      "^/api/": { target },
    },
  },
  preview: {
    host: "127.0.0.1",
  },
});
