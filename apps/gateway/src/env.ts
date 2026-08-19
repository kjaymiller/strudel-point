import { config as loadDotenv } from "dotenv";
import path from "node:path";

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
};
