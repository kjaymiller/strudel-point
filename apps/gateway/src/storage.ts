import { SpanStatusCode } from "@opentelemetry/api";
import { Client as S3Client } from "minio";
import { env } from "./env.js";
import { tracer } from "./telemetry.js";

// The "minio" npm package is just an S3-protocol client — it works unmodified against
// any S3-compatible server, and nothing here is specific to one. RustFS runs behind it
// locally (see docker-compose.yml); production points the same client at Wasabi (see
// docker-compose.prod.yml). Kept the package, renaming the import so the code doesn't
// read as MinIO-specific, rather than switching client libraries for the move.
// Formerly Valkey (see git history): that was a TTL'd cache, capped at 5MB since bytes
// lived in RAM; this is real object storage, so uploads can be much bigger, but "how long
// does an unused sample live" now has to be expressed as a bucket lifecycle rule instead
// of a per-key EXPIRE.
export const storage = new S3Client({
  endPoint: env.s3Endpoint,
  port: env.s3Port,
  useSSL: env.s3UseSsl,
  region: env.s3Region,
  accessKey: env.s3AccessKey,
  secretKey: env.s3SecretKey,
});

const BUCKET = env.s3Bucket;
const objectKey = (id: string) => `samples/${id}`;

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "NoSuchKey" || code === "NotFound";
}

// Provisions the bucket + its expiry rule idempotently on startup, rather than via a
// separate `mc`-based init container — keeps "how long do samples live" defined in one
// place (env.sampleTtlDays) instead of split between docker-compose and here.
//
// Skippable (S3_PROVISION=false) because that only works when the credential owns the
// bucket. Against a managed provider the bucket is usually created once in the console
// and the app's key is scoped to it, with no CreateBucket/PutBucketLifecycle rights at
// all — there the rule is the provider's to enforce and this function has nothing to do.
export async function connectStorage() {
  if (!env.s3Provision) return;

  // Deliberately not `.catch(() => false)`. Swallowing the error here treats "the
  // endpoint is unreachable" and "these credentials are wrong" as "bucket is missing",
  // and the recovery for a missing bucket is makeBucket — so a typo'd secret key
  // surfaced as a confusing CreateBucket failure instead of the AccessDenied it was.
  // Let it throw: the gateway should refuse to start on a misconfigured store.
  if (!(await storage.bucketExists(BUCKET))) {
    // Racy by nature — two gateway replicas starting together both see "missing" and
    // both create. The loser gets told the bucket already exists, which is exactly the
    // state it wanted, so that is a success, not an error.
    await storage.makeBucket(BUCKET).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw err;
    });
  }

  // Fixed expiration since upload — NOT the old cache's sliding "refreshed on every
  // play" TTL. Bucket lifecycle rules (S3, Wasabi and MinIO alike) key off an object's
  // own creation time; there's no last-accessed hook to reset it against. A well-loved
  // sample can still fall off this cliff mid-session. If that turns out to matter,
  // revisit with an app-level "touch" (re-upload, or copy-object-onto-itself to reset
  // the timestamp) on every play, rather than relying on the bucket rule alone.
  //
  // Deleting early does not stop the meter on every provider: Wasabi bills a minimum
  // storage duration regardless of when the object goes away (see env.sampleTtlDays).
  await storage.setBucketLifecycle(BUCKET, {
    Rule: [
      {
        ID: "expire-custom-samples",
        Status: "Enabled",
        Filter: { Prefix: "samples/" },
        Expiration: { Days: env.sampleTtlDays },
      },
    ],
  });
}

export async function disconnectStorage() {
  // Nothing to tear down — minio-js is just an HTTP client, no persistent
  // connection/socket like Valkey's to close.
}

// The "minio" package has no OTel auto-instrumentation of its own to begin with (unlike
// pg/kafkajs, which do but can't hook under Bun — see telemetry.ts), so every call
// against the object store gets a manual span here, same shape as db.ts/kafka.ts.
async function traced<T>(op: string, key: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`s3.${op}`, async (span) => {
    span.setAttribute("rpc.system", "aws-api"); // closest stable semconv for an S3-style call
    span.setAttribute("aws.s3.bucket", BUCKET);
    span.setAttribute("aws.s3.key", key);
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function putSampleBytes(id: string, data: Buffer) {
  await traced("putObject", objectKey(id), () => storage.putObject(BUCKET, objectKey(id), data, data.length));
}

/** Returns the audio bytes, or null if this sample's object has expired or never existed. */
export async function getSampleBytes(id: string): Promise<Buffer | null> {
  return traced("getObject", objectKey(id), async () => {
    try {
      const stream = await storage.getObject(BUCKET, objectKey(id));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  });
}

export async function sampleExists(id: string): Promise<boolean> {
  return traced("statObject", objectKey(id), async () => {
    try {
      await storage.statObject(BUCKET, objectKey(id));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  });
}

export async function deleteSampleBytes(id: string) {
  await traced("removeObject", objectKey(id), () =>
    storage.removeObject(BUCKET, objectKey(id)).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    }),
  );
}
