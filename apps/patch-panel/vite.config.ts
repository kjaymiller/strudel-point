import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Runs as the `patch-panel` service in docker-compose.yml — a Novation-Peak-style
// synth designer, sharing the same gateway as web/dj/pads (channelId-scoped rooms), so
// a room's tracks/samples show up here too. See apps/pads/vite.config.ts (this file is a
// straight copy of it, port/base aside) for why /api is proxied here but /ws is not.
export default defineConfig({
  plugins: [react()],
  // Unset (plain "/") for standalone/direct access (http://localhost:5191/#room) — only
  // the docker-compose `patch-panel` service sets BASE_PATH=/patch/, for when Caddy is
  // fronting all four apps on one origin and this one needs to live under /patch.
  base: process.env.BASE_PATH || "/",
  server: {
    host: true,
    port: 5191,
    proxy: {
      "/api": "http://gateway:8787",
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
