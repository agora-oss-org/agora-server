import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

// The admin app version (shown in the Topbar) is the single source of truth in package.json — read it
// here and inject as the `__APP_VERSION__` global so the bundle carries it without a runtime fetch.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

// @agora-server/contract resolves through the pnpm workspace symlink + its `exports` map (built dist/).
// Tailwind v4 is wired via its Vite plugin (CSS-first config lives in src/index.css `@theme`).
export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      port: 5173,
      // Dev-only: proxy the API so the SPA talks same-origin (mirrors the nginx prod reverse proxy).
      proxy: {
        "/v7": { target: "http://localhost:4000", changeOrigin: true },
        "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: true },
        // The services/scorer service (default :4001). Rewrite the /moderator prefix to /v1 so it
        // lands on the moderator's own /v1/:projectId/moderation/* routes (the admin client builds
        // /moderator/:projectId/...). In prod, point this at the moderator host.
        "/moderator": {
          target: "http://localhost:4001",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/moderator/, "/v1"),
        },
      },
    },
  };
});
