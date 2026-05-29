import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @agora/contract resolves through the pnpm workspace symlink + its `exports` map (built dist/).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
