# strudel-point

A [flok.cc](https://flok.cc)-style collaborative live-coding room for [Strudel](https://strudel.cc),
with Kafka as the event backbone between clients, Postgres for saved tracks/metadata, RustFS
(S3-compatible object storage) for user-uploaded audio, and Valkey for cross-instance presence
and autosave buffering.

## Architecture

```mermaid
flowchart LR
    browser(["browser"])

    subgraph edge["one origin, via caddy :8088"]
        web["web\nVite+React+CodeMirror6"]
        dj["dj\nVite+React deck mixer"]
        pads["pads\nVite+React sample pads"]
    end

    gw["gateway\nNode/TS"]
    kafka[("Kafka\nstrudel.channel.events")]
    pg[("Postgres\ntracks, custom_samples")]
    rustfs[("RustFS\nsample audio, 24h TTL")]
    valkey[("Valkey\npresence, autosave buffer")]

    browser -- "/ , /dj , /pads" --> edge
    browser -- "WS /ws (direct, not proxied)" --> gw

    web -- "REST /api (proxied)" --> gw
    dj -- "REST /api (proxied)" --> gw
    pads -- "REST /api (proxied)" --> gw

    gw -- "produce/consume,\nkeyed by channelId" --> kafka
    gw -- "tracks + sample metadata" --> pg
    gw -- "upload/fetch sample bytes" --> rustfs
    gw -- "roster + buffered autosaves\n(optional: degrades if down)" --> valkey

    style edge fill:none,stroke-dasharray: 4 4
```

Every client app speaks the same two protocols to the same gateway: **WebSocket `/ws`** for realtime room events, and **REST `/api`** for tracks and samples. `/ws` is the one exception to "browser never talks to the gateway directly" — it bypasses Caddy/Vite's proxy entirely (a proxied WS upgrade hangs forever under Bun's `http.request`), so the gateway's port is published straight to the browser. `/api` goes the normal route: browser → app's own Vite dev server → its proxy → gateway.

### Why events go through Kafka instead of a direct broadcast

```mermaid
sequenceDiagram
    participant A as client A
    participant GW as gateway
    participant K as Kafka topic
    participant B as client B

    A->>GW: doc:update / eval (WS)
    GW->>K: produce (key = channelId)
    K->>GW: consume
    GW->>B: broadcast (WS)
    GW->>A: broadcast (WS)
```

The gateway never fans an event out on receipt — it only ever broadcasts what it *consumes back* off Kafka, including to the sender. That keeps behavior identical whether one gateway instance is running or ten, and gives a durable, replayable log for free.

Everything except the web container's own port is **internal to the Docker network** —
gateway talks to `kafka:9092`/`postgres:5432`/`rustfs:9000`/`valkey:6379` by Docker's internal DNS, and the
browser never talks to the gateway directly; Vite's own server-side proxy does that from
inside the web container. The only host port that has to exist is the one the browser hits.

- **No CRDT.** Each channel/room has one shared buffer; edits are broadcast as full-content
  `doc:update` events, last write wins. Fine for a "everyone's looking at one editor"
  live-coding session; would need real conflict resolution (e.g. Yjs) for true multi-cursor
  concurrent editing.
- **Kafka is the only fan-out path.** The WS gateway never broadcasts directly on receipt —
  it publishes to Kafka, then broadcasts whatever it consumes back off the topic. This keeps
  behavior identical whether one gateway instance is running or several, and gives you a
  durable, replayable event log for free.
- **Audio happens per-browser.** Like flok.cc, nobody's audio is server-rendered — every
  client runs its own `@strudel/web` instance and locally evaluates whatever `eval` events
  come through, so everyone in the room hears the pattern.
- **Presence is a Valkey sorted set, not the event stream.** `GET
  /api/channels/:id/presence` returns the full roster across every gateway instance, so a
  client joining a busy room sees who's already there rather than only learning about
  arrivals after it connected. See the Valkey section below.

## Valkey: presence and the autosave buffer

Valkey used to *hold* custom sample audio — the only copy, which is why it had a 5MB cap and
why losing it lost data. `storage.ts` owns those bytes now. It's back in a narrower role, and
the rule that keeps it honest is that **nothing in it is a system of record**: everything here
is either re-derived (presence) or has a durable copy elsewhere (autosaves → Postgres).

```mermaid
flowchart LR
    ws["WS join /\n30s heartbeat"] -- "ZADD presence:{ch}:peers" --> vk[("Valkey")]
    put["PUT /api/…/autosave"] -- "SET + SADD dirty" --> vk
    vk -- "ZREVRANGE" --> get["GET /api/…/presence"]
    vk -- "SPOP dirty → UPSERT\nevery 15s" --> pg[("Postgres")]
```

**Presence** (`apps/gateway/src/presence.ts`). This is the one thing the Kafka fan-out design
can't give you: every instance runs its own consumer group and broadcasts to its own sockets,
which is exactly why no instance knows who's connected to any other. `rooms.ts` is a plain
in-process `Map`, so `peerCount` used to mean "peers on whichever instance you happened to
ask" — and a client's peer list was join-order-only, missing everyone already in the room.
A sorted set per channel, scored by last-seen timestamp, fixes both: the score doubles as the
liveness reaper for sockets that died without a clean close (reaped on read, so there's no
per-channel background sweep). The ws heartbeat in `index.ts` refreshes the score on the same
30s tick it pings on, and a peer drops off the roster after three consecutive misses.

**Autosave buffering** (`apps/gateway/src/autosaveBuffer.ts`). The web client debounces
autosave to 3s and also fires one on every evaluate, so a room with someone actively typing
was doing an UPSERT into `autosaves` every few seconds, forever, for a row nobody reads until
a reload. Writes now land in Valkey and mark the channel dirty; a flusher drains the dirty set
into Postgres every 15s (and once more on shutdown). Postgres is still the durable copy — this
changed *when* it's written, not whether.

The honest trade: losing Valkey between flushes loses up to 15s of autosave. That's acceptable
*here specifically* because autosave is already the explicitly lossy tier — a debounced
best-effort snapshot, deliberately distinct from a saved `Track`, which still writes straight
to Postgres synchronously. It would not be acceptable for tracks, and the pattern shouldn't be
copied there.

The flusher is safe to run on every instance concurrently: `SPOP` *claims* channels atomically,
so two instances can't flush the same one, and a write landing after the pop simply re-adds the
channel for the next tick (rather than being lost, which is what read-then-`SREM` would do).

**It's optional, and that's enforced in code, not just documented.** The client runs with
`enableOfflineQueue: false`, so when Valkey is down commands fail on the first attempt instead
of buffering and firing late — every call goes through one `withValkey()` helper that falls
back to the lesser thing: presence degrades to per-instance (the old behavior), autosave writes
straight through to Postgres. `docker-compose.yml` depends on it with `service_started`, not
`service_healthy`, for the same reason. Watch
`gateway_valkey_errors_total` in Prometheus — that counter is the only outward sign a request
took the degraded path. Verified both directions: with Valkey down the gateway starts and
serves normally, and it reconnects on its own once Valkey comes back.

The compose service has no volume, deliberately, and runs `--maxmemory-policy allkeys-lru`:
eviction here is a cache miss, not data loss.

## `tracks` table

```sql
tracks (
  id            uuid primary key,
  channel_id    text,
  title         text,
  author        text,
  code          text,         -- raw source, as typed
  strudel_json  jsonb,        -- { code, cps?, tags?, version } — see packages/shared/src/tracks.ts
  created_at    timestamptz,
  updated_at    timestamptz
)
```

`strudel_json` is deliberately a superset of `code` (not just the string) so future fields —
tempo, tags, multi-pane layouts — don't need a schema migration, just a jsonb shape change.

## Custom sounds (drag-and-drop audio)

Dropping an audio file into the "my sounds" tab uploads it and registers it with Strudel by
name (`s("myclap")`), broadcasting to everyone else in the room over the same Kafka topic.

The audio bytes themselves live in **RustFS, not Postgres** — `custom_samples` only holds
metadata (name, size, mime type). This was a deliberate change from an earlier bytea-in-Postgres
version: uploaded audio is session-scoped, throwaway material, not something that should grow a
database backup forever. Instead:

- Bytes expire after a **fixed 24h**, via a bucket lifecycle rule (`apps/gateway/src/storage.ts`,
  `SAMPLE_TTL_DAYS`) — set once at startup, not per-upload. Unlike the Valkey-backed cache this
  replaced, that expiry is *not* refreshed on play: object storage has no last-accessed hook to
  reset against, so an actively-used sound can still age out mid-session at the 24h mark. If that
  turns out to matter in practice, it'd need an app-level "touch" on every play instead.
- The metadata row is deleted the moment its object is found expired (checked when the sidebar
  list loads, or on a playback 404) — so Postgres never accumulates dead rows either.
- Upload cap is 50MB — real object storage, not a RAM-backed cache, so this is a "keep it to one
  sample/loop" guard rail rather than a memory constraint.

If you want a custom sound to genuinely outlive 24h of inactivity, save it as part of a `Track`
(the `code` references the sample by name; re-upload the audio in a fresh session) — tracks and
custom sounds are deliberately different durability tiers.

## DJ mixing (`apps/dj`)

A separate app (own Vite dev server, own `docker-compose.yml` service) that turns a room's
*existing saved Tracks* into a two-deck DJ mixer. dj's whole job is playing tracks that
already exist — it never touches audio files or sample banks; that's `apps/pads`'s job
(below). A deck here holds a whole `Track`'s Strudel source, not decoded audio, so there's
no waveform, no bpm-guessing, no scrubbing — just code, played (and shaped) as whatever it
already is:

- **Decks play whole tracks** — each deck picks from this room's saved tracks and plays
  the pattern as-is, `.speed()`-shifted and optionally filtered.
- **hpf/lpf/lfo/duck knobs** — a highpass, a lowpass (with an lfo that sweeps its cutoff),
  and a "duck": a rhythmic, cycle-synced gain dip for a sidechain-pump feel. Explicitly
  *not* a true audio-reactive sidechain compressor — that would need an envelope follower
  actually listening to the other deck's live output, which is real Web Audio graph work
  Strudel's pattern language doesn't do. See `chain.ts`'s `DeckConfig` for the honest
  version this actually is.
- **Tempo** — a deck's effective tempo is whatever its track's own `setcps()` declared
  (parsed back out by `splitTrackCode`) times its `.speed()` knob; a track with no
  declared tempo falls back to a default rather than guessing one. "sync" matches a
  deck's speed to whichever deck is "master".
- **Crossfader** — equal-power crossfade between the two decks' gains.
- **A hard "cut"** — Strudel's `evaluate()` only affects what gets scheduled *going
  forward*; it never retroactively silences a track already sounding, and there's no
  per-deck kill switch in Strudel's public API. "cut" is the honest version of "stop
  immediately": it hushes the whole mix for an instant, marks that deck stopped, and lets
  the next debounced re-evaluate bring the other deck back in without it.
- **Show code** — a toggle reveals the actual Strudel driving the live mix (every knob is
  just recompiling this), and you can edit it directly; touching any knob/deck reverts to
  knob-generated code.
- **Sync with the room** — every knob/fader move recompiles the mix into real Strudel
  source and evaluates it locally, then broadcasts it as the same `eval` event the main
  editor sends on ctrl+enter. Everyone in the room hears the live mix; Strudel hot-swaps
  the running pattern rather than restarting it, so this is a continuous remix, not a
  series of restarts.
- **Sets as a chain, saved as a Track** — "add scene" freezes the current mix for N
  cycles into an ordered chain, auto-saved as one Strudel track (`arrange()` under the
  hood) through the existing Tracks API — a normal `Track`, playable from the main editor
  too, shareable as a URL carrying both the room number and the set:
  `.../dj/?track=<id>#<room>`.

No gateway/database changes were needed for any of this — it's a client reusing the same
REST/WS surface the main app already exposes.

## Sample pads (`apps/pads`)

A third app, split out from what used to live inside `apps/dj`: cutting an uploaded audio
file into a bank of one-cycle slices (drag-drop → analyze → cut, same "analyze beat"
technique `BeatAnalyzer` uses) and triggering those slices from a 16-pad grid. This is
where sample banks actually get created and played as one-shots — dj never handles raw
audio at all anymore, only the Tracks this (or the main) app already saved.

## Running locally

Everything runs as Docker containers — Kafka, Postgres, RustFS, Valkey, the gateway, and the
web dev server. `mise trust` once if this is the first time mise has seen this directory, then:

```sh
mise install       # installs bun at the pinned version (used for one-off scripts + host tooling)
mise run docker:up # builds + starts everything (Kafka, Postgres, RustFS, Valkey, gateway, web)
mise run migrate   # applies db/migrations/*.sql, run from inside the gateway container
mise run dev       # follows gateway + web logs (docker:up already started them)
```

`mise run install` (plain `bun install` on the host) is separate and optional — it's only for
your editor's TypeScript server / running `tsc --noEmit` locally, since the containers install
their own copy of `node_modules` at build time (deliberately: this is a monorepo built on macOS
ARM but the containers are Linux, and something like Vite's `esbuild` ships platform-specific
native binaries — sharing a host-installed `node_modules` into the container would just break).

Kafka/Postgres/RustFS/Valkey publish **no host ports at all** — nothing to collide with, since the
gateway reaches them by Docker-internal DNS name instead of `localhost:<port>`. The one port
that does need to reach your browser (Vite's dev server) is published as a small range —
`5173-5178:5173` — so Docker itself binds whichever's actually free; run `docker compose port
web 5173` (or just `docker compose ps`) to see which one it picked if 5173 was already taken.

Open `http://localhost:5173/#my-room` (or whichever port got picked) — the text after `#` is the
channel/room id. Open the same URL in a second tab (or another browser) to see live collaboration.

- `⌘/Ctrl + Enter` — evaluate the current buffer
- `⌘/Ctrl + .` — hush (stop all sound in this browser)
- **save** — writes the current buffer to Postgres as a `Track`

## Running in production

`docker-compose.yml` is the development stack and only that — bind-mounted source, Vite
dev servers, `bun --watch`. `docker-compose.prod.yml` is the deployable one:

```sh
cp .env.prod.example .env    # fill in POSTGRES_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm gateway bun scripts/migrate.js
```

Then point a TLS-terminating reverse proxy at `HTTP_PORT` (default 8088). Three things
are genuinely different from dev, not just tuned:

**One origin, one port.** `Dockerfile.static` builds all four apps as static bundles and
serves them from a single Caddy container (`Caddyfile.prod`), which also proxies `/api`
and `/ws` to the gateway. The gateway publishes no host port. This is why the dev
workaround — the browser dialing the gateway's `:8787` directly for the WebSocket —
disappears in production: that exists purely because Vite's proxy can't complete a WS
upgrade under Bun, and there is no Vite here. Caddy proxies upgrades correctly. So
`apps/*/src/ws.ts` defaults to same-origin whenever `import.meta.env.PROD` is set, which
also keeps the built image hostname-agnostic — no rebuild to deploy it behind a different
domain. `VITE_GATEWAY_WS_HOST` still overrides, for a split-origin deployment.

**No default credentials.** Dev hardcodes `strudel`/`strudel` everywhere. The prod compose
uses `${VAR:?}` for every secret, so the stack refuses to start rather than quietly
running with a password that's published in this repo. `CORS_ORIGIN` defaults to empty,
which the gateway reads as "same-origin, send no CORS headers at all" (see `env.ts`) —
correct here, since the browser never makes a cross-origin request.

**The gateway image is a single bundled file.** `apps/gateway/Dockerfile` runs
`bun build --target=bun`, inlining the workspace packages and every dependency, so the
runtime stage carries `server.js` and nothing else — no `node_modules`, no lockfile. The
migrator is bundled alongside it (`scripts/migrate.js`) with the raw `db/migrations/*.sql`
next to it, since that image is the only place a Postgres client exists. Every migration
is written `if not exists`, so re-running it on each deploy is safe.

Observability is deliberately absent from the prod compose — no Jaeger, no Prometheus, no
collector. Those are dev conveniences; a real deployment usually has its own. Set
`OTEL_EXPORTER_OTLP_ENDPOINT` to emit traces and scrape `gateway:8787/metrics` for
metrics. Note that `/metrics` is *not* proxied through the public origin, so it stays on
the internal network rather than sitting unauthenticated on the front door.

## Telemetry (OpenTelemetry + Jaeger)

The gateway is instrumented with the OpenTelemetry Node SDK (`apps/gateway/src/telemetry.ts`,
imported first thing in `index.ts` so `http`/`express` get patched before anything else
touches them). It exports traces over OTLP/HTTP to an `otel-collector` container, which
forwards them on to `jaeger` (native OTLP, no jaeger-specific exporter needed) for viewing.

```mermaid
flowchart LR
    gw["gateway"] -- "OTLP/HTTP" --> col["otel-collector"] -- "OTLP/gRPC" --> jae["jaeger"] --> ui(["Jaeger UI"])
```

Traces cover incoming HTTP requests (`/api/*`), WebSocket handling, and every one of this
app's four backing-service calls — Postgres queries, Kafka produce/consume, RustFS/S3
object calls, and Valkey commands — enough to see, e.g., a `save` request's full path from
`/api/tracks` down through the `pg` query it issued, or a sample upload down through its
`s3.putObject`.

**Why Postgres/Kafka/S3/Valkey use manual spans instead of auto-instrumentation:** the standard
approach (`getNodeAutoInstrumentations()` in `telemetry.ts`) covers `pg`, `kafkajs`, and
friends out of the box — but only via a require/import hook that patches each package the
moment it's loaded, and confirmed against a live run, that hook doesn't fire under Bun for
packages this app reaches through ESM `import` (only Node's own core `http`/`net` modules
still get patched, since those are patched directly rather than via the hook). Rather than
depend on that, `db.ts` (wraps `pool.query` once, so every route gets it for free),
`kafka.ts` (`publishChannelEvent` / the consumer's `eachMessage`), `storage.ts` (every
`putObject`/`getObject`/`statObject`/`removeObject` call), and `valkey.ts` (the one
`withValkey` helper every presence/autosave call goes through) each start their own span by
hand, using the `tracer` `telemetry.ts` exports. Revisit this if a future OTel/Bun release closes
that hook gap — the manual spans could then be dropped in favor of the bundled ones.

- `otel-collector` publishes no host port, same reasoning as kafka/postgres/rustfs — only
  the gateway talks to it, over Docker-internal DNS (`otel-collector:4317`/`4318`).
- `jaeger`'s UI is published as a small range (`16686-16690:16686`), same idea as
  web/dj/pads, so it doesn't collide with another project's Jaeger already sitting on
  16686. Run `docker compose port jaeger 16686` (or `docker compose ps`) to see which port
  got picked, then open `http://localhost:<port>` and search for service
  `strudel-point-gateway`.
- Jaeger's all-in-one image stores traces in memory — they don't survive `docker compose
  down`. Fine for local dev; swap in a real storage backend if you need traces to persist.
- The collector config (`otel/otel-collector-config.yaml`) is the one place to add more
  exporters later (metrics, a hosted backend, etc.) without touching any instrumented app.
- Outside docker-compose (e.g. running the gateway bare on a host), `telemetry.ts` no-ops
  when `OTEL_EXPORTER_OTLP_ENDPOINT` isn't set, rather than failing every request trying
  to reach a collector that isn't there.

## Pointing at Aiven instead of local docker-compose

Copy `apps/gateway/.env.example` to `apps/gateway/.env` and fill in:

- `KAFKA_BROKERS`, `KAFKA_SSL=true`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` — from an
  Aiven for Apache Kafka service.
- `DATABASE_URL` — from an Aiven for PostgreSQL service (`sslmode=require`).
- `VALKEY_URL` — from an Aiven for Valkey service. Paste the service URI as-is; the
  `valkeys://` (or `rediss://`) scheme turns TLS on by itself. Optional, like everywhere else
  Valkey shows up here — leave it pointing at nothing and the gateway just runs degraded.
- `S3_ENDPOINT`, `S3_PORT`, `S3_USE_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — from wherever you're
  actually running/using S3-compatible object storage. **There's no Aiven-managed equivalent for
  this one** — it'd mean either self-hosting RustFS somewhere real (a VM, a container platform) or
  pointing the same client straight at AWS S3 or another provider instead. Local docker-compose's
  RustFS container is dev-only.

I haven't provisioned any of these yet — say the word and I'll set up the OpenTofu for a
dev-tier Kafka + PostgreSQL + Valkey in project `jay-miller` / `do-nyc`, per your usual setup,
plus we'd need to separately decide where the object storage half actually lives, since that
one's not something Aiven's OpenTofu provider can stand up,
and confirm the exact specs with you before creating anything.

## What's not here yet

- Auth (rooms are open to whoever has the URL, like flok.cc)
- Multi-pane layouts (Strudel/Hydra/Tidal side by side, like flok.cc's real target list)
- Kafka topic retention/compaction tuning (currently whatever the broker defaults to)
- Tests
