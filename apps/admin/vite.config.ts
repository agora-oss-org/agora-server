import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @agora-server/contract resolves through the pnpm workspace symlink + its `exports` map (built dist/).
// Tailwind v4 is wired via its Vite plugin (CSS-first config lives in src/index.css `@theme`).
export default defineConfig(({ mode }) => {
  // The root .env (direnv-managed, ../../) holds AGORA_UMAMI_* — read it at build time to inject the
  // admin app's Umami tracking <script>. `loadEnv(.., "")` also picks up process.env (direnv exports
  // these into the shell, so CI/Docker can pass them as plain env). Empty/unset → no script (off).
  const rootEnv = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const umamiUrl = (rootEnv.AGORA_UMAMI_URL ?? "").trim().replace(/\/+$/, "");
  const umamiSite = (rootEnv.AGORA_UMAMI_ADMIN_ID ?? "").trim();
  // Umami's tracking script auto-tracks pageviews incl. SPA route changes (it patches History). The
  // data-website-id binds this build to the *admin* Umami site (separate from the server-events site).
  // data-host-url carries the full mount (incl. any /umami path prefix) so the tracker POSTs events to
  // `${umamiUrl}/api/send` — the script's src origin alone would miss the prefix.
  const umamiTag =
    umamiUrl && umamiSite
      ? `<script defer src="${umamiUrl}/script.js" data-website-id="${umamiSite}" data-host-url="${umamiUrl}"></script>`
      : "";

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        // Inject the Umami <script> into <head> at build (no-op when unconfigured).
        name: "agora-umami-script",
        transformIndexHtml(html: string) {
          return umamiTag ? html.replace("</head>", `    ${umamiTag}\n  </head>`) : html;
        },
      },
    ],
    server: {
      port: 5173,
      // Dev-only: proxy the API so the SPA talks same-origin (mirrors the nginx prod reverse proxy).
      proxy: {
        "/v7": { target: "http://localhost:4000", changeOrigin: true },
        "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: true },
        // The @agora/moderator service (default :4001). Rewrite the /moderator prefix to /v1 so it
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
