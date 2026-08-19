import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Runs as the `web` service in docker-compose.yml. `host: true` binds all interfaces
// (not just the container's localhost) so the host port mapping in docker-compose.yml
// can actually reach it. /api is proxied to the gateway container's Docker-internal DNS
// name — the browser never talks to it directly for that, only Vite's own server-side
// proxy does. /ws is NOT proxied here — the browser connects straight to the gateway's
// own published port instead (see apps/web/src/ws.ts and the `ports:` comment on
// gateway in docker-compose.yml for why: Vite's proxy can't complete a WS handshake
// under Bun).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://gateway:8787",
    },
    // Bind-mounted volumes into a container don't reliably deliver inotify events
    // (observed directly: files landed correctly, HMR just never fired) — polling is
    // the standard fix, at the cost of a bit of CPU from the periodic stat() calls.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
