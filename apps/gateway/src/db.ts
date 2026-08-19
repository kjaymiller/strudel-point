import pg from "pg";
import { SpanStatusCode } from "@opentelemetry/api";
import { env } from "./env.js";
import { tracer } from "./telemetry.js";

// Aiven for PostgreSQL requires SSL. Detect it positively (rather than excluding known
// local hostnames like "postgres"/"localhost") so this doesn't misfire against whatever
// this is running next to — docker-compose's internal network, a bare host process, etc.
const requiresSsl = env.databaseUrl.includes("aivencloud.com") || env.databaseUrl.includes("sslmode=require");

const rawPool = new pg.Pool({
  connectionString: env.databaseUrl,
  // TODO(prod): pass Aiven's service CA cert here (ssl: { ca: ... }) instead of
  // disabling verification once this points at a real Aiven for PostgreSQL service.
  ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
});

// @opentelemetry/instrumentation-pg (bundled by getNodeAutoInstrumentations in
// telemetry.ts) would normally give every query its own span for free, but that
// instrumentation patches `pg` via a require/import hook that doesn't fire under Bun for
// this ESM-imported package (see telemetry.ts) — so every route calling `pool.query`
// would otherwise be invisible in traces. Wrapping `query` once here, instead of at each
// of the many call sites across routes/, gets every one of them traced for free.
const boundQuery = rawPool.query.bind(rawPool);
export const pool: pg.Pool = Object.assign(rawPool, {
  query(...args: Parameters<typeof boundQuery>) {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
    return tracer.startActiveSpan(`pg.query`, async (span) => {
      span.setAttribute("db.system", "postgresql");
      if (text) span.setAttribute("db.statement", text);
      try {
        return await boundQuery(...args);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
  },
});
