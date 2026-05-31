import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @agora/contract resolves through the pnpm workspace symlink + its `exports` map (built dist/).
// Tailwind v4 is wired via its Vite plugin (CSS-first config lives in src/index.css `@theme`).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev-only: proxy the API so the SPA talks same-origin (mirrors the nginx prod reverse proxy).
    proxy: {
      "/v7": { target: "http://localhost:4000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: true },
      // The @agora/moderator service (default :4001). Strip the /moderator prefix so it lands on the
      // moderator's own /v7/:projectId/moderation/* routes. In prod, point this at the moderator host.
      "/moderator": {
        target: "http://localhost:4001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/moderator/, ""),
      },
    },
  },
});
