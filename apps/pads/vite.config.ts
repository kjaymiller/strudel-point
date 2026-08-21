import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Runs as the `pads` service in docker-compose.yml — a separate app from `web`/`dj`,
// sharing the same gateway (rooms/tracks/samples are all channelId-scoped, so all three
// apps just point at the same room and see the same data). See apps/web/vite.config.ts
// for why /api is proxied here but /ws is not (the browser talks straight to the
// gateway's own published port for that — apps/pads/src/ws.ts is a copy of that same
// workaround).
export default defineConfig({
  plugins: [react()],
  // Unset (plain "/") for standalone/direct access (http://localhost:5185/#room, or
  // `bun run dev` on the host) — only the docker-compose `pads` service sets
  // BASE_PATH=/pads/, for when Caddy is fronting all three apps on one origin and this
  // one needs to live under /pads so its asset requests don't collide with the others'.
  base: process.env.BASE_PATH || "/",
  server: {
    host: true,
    port: 5185,
    proxy: {
      "/api": "http://gateway:8787",
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
