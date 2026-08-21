import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Runs as the `dj` service in docker-compose.yml — a separate app from `web`, sharing the
// same gateway (rooms/tracks/samples are all channelId-scoped, so both apps just point at
// the same room and see the same data). See apps/web/vite.config.ts for why /api is
// proxied here but /ws is not (the browser talks straight to the gateway's published port
// for that — apps/dj/src/ws.ts is a copy of that same workaround).
export default defineConfig({
  plugins: [react()],
  // Unset (plain "/") for standalone/direct access (http://localhost:5179/#room, or
  // `bun run dev` on the host) — only the docker-compose `dj` service sets BASE_PATH=/dj/,
  // for when Caddy is fronting both apps on one origin and this one needs to live under
  // /dj so its asset requests don't collide with the root app's.
  base: process.env.BASE_PATH || "/",
  server: {
    host: true,
    port: 5179,
    proxy: {
      "/api": "http://gateway:8787",
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
