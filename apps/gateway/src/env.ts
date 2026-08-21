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
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  // Custom-sample audio bytes (see storage.ts) — local docker-compose RustFS by default.
  // RustFS speaks the plain S3 API, so the same client works against any other
  // S3-compatible provider too (self-hosted or not) — just point these at it. Named
  // generically (S3_*, not RUSTFS_*) for exactly that reason: the client doesn't care
  // which S3-compatible server is on the other end. No Aiven-managed equivalent exists
  // today, unlike the other three services this app talks to.
  s3Endpoint: process.env.S3_ENDPOINT ?? "rustfs",
  s3Port: Number(process.env.S3_PORT ?? 9000),
  s3UseSsl: process.env.S3_USE_SSL === "true",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "strudel",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "strudel-dev-secret",
  s3Bucket: process.env.S3_BUCKET ?? "custom-samples",
  // Fixed expiration since upload, via a bucket lifecycle rule (see storage.ts) — not
  // the old Valkey cache's sliding "refreshed on every play" TTL, which object storage
  // has no equivalent hook for.
  sampleTtlDays: Number(process.env.SAMPLE_TTL_DAYS ?? 1),

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
};
