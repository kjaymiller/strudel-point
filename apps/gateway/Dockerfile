# Production image for the gateway. The sibling Dockerfile.dev is the live-reload one
# (bind-mounted source, `bun --watch`, node_modules in a named volume); this one bakes a
# single self-contained artifact and mounts nothing.
#
# Why `bun build --target=bun` into one file rather than `tsc` + a node_modules tree:
# packages/shared sets `"main": "./src/index.ts"`, so a tsc-emitted dist would still
# import TypeScript source out of node_modules at runtime, and the runtime image would
# have to carry the whole workspace to resolve it. Bundling inlines the workspace
# packages and every npm dependency, so the runtime stage needs the bundle and nothing
# else — no install step, no lockfile, no node_modules.

# ── deps ─────────────────────────────────────────────────────────────────────
# Manifests only, so this layer stays cached until a package.json or the lockfile
# actually changes. Every workspace manifest the root `workspaces` glob resolves has to
# be present or bun install silently resolves almost nothing (same trap Dockerfile.dev
# documents).
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/library/package.json packages/library/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/dj/package.json apps/dj/package.json
COPY apps/pads/package.json apps/pads/package.json
COPY apps/patch-panel/package.json apps/patch-panel/package.json
RUN bun install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY packages packages
COPY apps/gateway apps/gateway
COPY scripts scripts
COPY tsconfig.json* ./
# Typecheck before bundling: `bun build` happily strips types without checking them, so
# without this a type error would ship instead of failing the build.
RUN bun run --filter @strudel-point/gateway typecheck
RUN bun build apps/gateway/src/index.ts --target=bun --outfile=/app/out/server.js
# The migrator ships in the same image, because a deployment needs some way to apply
# db/migrations/*.sql and this image is the only place a Postgres client exists.
# It must land in an `out/scripts/` subdirectory: migrate.mjs resolves its SQL as
# `import.meta.dirname/../db/migrations`, and that stays true of the bundle's own
# location, so the layout below has to mirror the repo's.
RUN bun build scripts/migrate.mjs --target=bun --outfile=/app/out/scripts/migrate.js

# ── runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

# `bun` (uid 1000) ships in the base image; run as it rather than root.
COPY --from=build --chown=bun:bun /app/out /app
# Raw .sql, read at migrate time — deliberately not bundled, so `docker run … cat` can
# still show exactly what a deployment is about to apply.
COPY --chown=bun:bun db/migrations /app/db/migrations

USER bun
ENV NODE_ENV=production
EXPOSE 8787

# Express serves this (see apps/gateway/src/index.ts) — plain 200/JSON, no auth, so it
# doubles as the compose healthcheck. /metrics sits next to it for Prometheus.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "/app/server.js"]
