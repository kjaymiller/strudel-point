import path from "node:path";
import { config as loadDotenv } from "dotenv";

// Explicit path, not the default `dotenv/config` (which resolves relative to
// process.cwd()) — the gateway container's CWD is /app (the bind-mounted repo root, so
// bun can resolve the @strudel-point/shared workspace symlink), not apps/gateway, so the
// default lookup would silently miss this file entirely.
loadDotenv({ path: path.resolve(import.meta.dirname, "..", ".env") });

// Defaults below assume this is running as the `gateway` service in docker-compose.yml,
// talking to the other services by their Docker-internal DNS names. Override any of
// these in apps/gateway/.env to point at Aiven instead (see .env.example) — that always
// wins over the defaults here.
export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://strudel:strudel@postgres:5432/strudel_point",
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? "kafka:9092").split(","),
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "strudel-point-gateway",
  // Aiven for Apache Kafka requires SSL + a service username/password (or client certs).
  // Set these when pointing at Aiven instead of the local docker-compose broker.
  kafkaSsl: process.env.KAFKA_SSL === "true",
  kafkaSaslUsername: process.env.KAFKA_SASL_USERNAME,
  kafkaSaslPassword: process.env.KAFKA_SASL_PASSWORD,
  // Three states, not two. Unset means the dev default below. A non-empty value is an
  // origin allowlist. An *explicitly empty* value means "same-origin deployment — send no
  // CORS headers at all", which is `false` to the cors middleware and is what
  // docker-compose.prod.yml defaults to: there, caddy serves the apps and proxies /api
  // from one origin, so the browser never makes a cross-origin request and an allowlist
  // would only be a way to accidentally widen access. Note `??` alone can't express this
  // — an empty string isn't nullish, so it would configure cors with "" and silently
  // match nothing.
  corsOrigin: process.env.CORS_ORIGIN === "" ? false : (process.env.CORS_ORIGIN ?? "http://localhost:5173"),

  // Custom-sample audio bytes (see storage.ts). Defaults are the local docker-compose
  // RustFS container — dev only. Production points these at Wasabi (see
  // docker-compose.prod.yml and .env.prod.example); the client is a plain S3-protocol
  // client, so RustFS, Wasabi, MinIO and AWS S3 are all the same code path. Named
  // generically (S3_*, not RUSTFS_* or WASABI_*) for exactly that reason.
  s3Endpoint: process.env.S3_ENDPOINT ?? "rustfs",
  s3Port: Number(process.env.S3_PORT ?? 9000),
  s3UseSsl: process.env.S3_USE_SSL === "true",
  // Explicit rather than left to the client's own discovery. Given no region, minio-js
  // issues a GetBucketLocation before the first real call — which needs a permission a
  // scoped-down Wasabi key may not have, and costs a round trip either way. Wasabi's
  // endpoint host is region-scoped too (s3.<region>.wasabisys.com), so this must agree
  // with S3_ENDPOINT or every request signs against the wrong region and 400s.
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "strudel",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "strudel-dev-secret",
  s3Bucket: process.env.S3_BUCKET ?? "custom-samples",
  // Fixed expiration since upload, via a bucket lifecycle rule (see storage.ts) — not
  // the old Valkey cache's sliding "refreshed on every play" TTL, which object storage
  // has no equivalent hook for.
  //
  // NOTE on Wasabi: this controls when the object is *deleted*, not when you stop paying
  // for it. Wasabi bills a minimum storage duration (90 days on the standard plan) — an
  // object deleted after 1 day is still charged as though it lived the full period. The
  // TTL keeps the bucket small, not the bill. See the S3 section of README.md.
  sampleTtlDays: Number(process.env.SAMPLE_TTL_DAYS ?? 1),
  // Whether the gateway provisions the bucket and its lifecycle rule on startup (see
  // connectStorage in storage.ts). True for the dev container, which starts empty. Set
  // S3_PROVISION=false when the bucket is managed outside the app — a Wasabi key scoped
  // to one existing bucket typically cannot CreateBucket or PutBucketLifecycle at all,
  // and failing startup over that would be wrong.
  s3Provision: process.env.S3_PROVISION !== "false",

  // Cross-instance presence + the autosave write buffer (see valkey.ts, presence.ts,
  // autosaveBuffer.ts). Neither is a system of record, so an unreachable Valkey degrades
  // those two features rather than failing requests — which is why there's no "disabled"
  // flag here: not having it running is already a supported state. iovalkey accepts
  // valkey:// and redis:// alike, and turns on TLS for the valkeys://rediss:// variants,
  // so an Aiven for Valkey URI drops straight in.
  valkeyUrl: process.env.VALKEY_URL ?? "valkey://valkey:6379",

  // Stem separation (see routes/stems.ts) — the dedicated Spleeter service, local
  // docker-compose by default. Internal-only: nothing outside this gateway ever needs to
  // reach it directly, so unlike S3_* above there's no "point this at a managed provider
  // instead" story — Spleeter has no hosted equivalent, this is always self-run.
  spleeterUrl: process.env.SPLEETER_URL ?? "http://spleeter:8100",

  // The in-room chatbot (see chat/). Missing config means the feature is simply off: the
  // routes still exist and answer GET /api/chat/status with enabled:false *and the reason*,
  // so the UI can say why the tab is quiet instead of failing on the first message.
  // Deliberately not a separate CHAT_ENABLED flag — credentials are the only thing that can
  // actually make it work, so having them *is* the flag.
  //
  // "anthropic" (default) is Claude through the official SDK. "openai-compatible" points the
  // same room tools at anything speaking POST /chat/completions — Ollama, vLLM, LM Studio,
  // OpenRouter, OpenAI — via CHAT_BASE_URL. See chat/agent.ts's resolveBackend.
  chatProvider: process.env.CHAT_PROVIDER === "openai-compatible" ? "openai-compatible" : "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  // No default: the right one depends on the provider, and a Claude model id silently sent
  // to a local Ollama is a 404 nobody can read. chat/agent.ts fills in claude-opus-5 for the
  // Anthropic path and refuses to guess for the other.
  chatModel: process.env.CHAT_MODEL,
  // OpenAI-compatible only. The API root, ending in /v1 for most servers.
  chatBaseUrl: process.env.CHAT_BASE_URL,
  // OpenAI-compatible only, and optional — a local Ollama or LM Studio checks nothing.
  chatApiKey: process.env.CHAT_API_KEY,
  // OpenAI-compatible only. Reasoning models can spend most of a turn on thinking tokens
  // that never reach the room, and a live-coding chat panel is somewhere latency is felt
  // directly. Opt-in because the flag it sends is a chat-template passthrough rather than
  // part of the OpenAI protocol — see createOpenAiCompatibleBackend.
  chatDisableThinking: process.env.CHAT_DISABLE_THINKING === "true",
} as const;
