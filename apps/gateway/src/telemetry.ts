// Must be imported (and its side-effecting start() called) before anything else in
// index.ts — instrumentation-node patches modules (http, express, pg, ...) at require
// time, so if express/pg are imported first, those specific instances never get patched.
//
// Talks to the collector over plain OTLP/HTTP, not straight to Jaeger — see
// otel/otel-collector-config.yaml for why that indirection exists. No endpoint set
// (bare `bun --watch` on a host, outside docker-compose) means no OTEL_EXPORTER_OTLP_ENDPOINT
// env var, and this quietly no-ops rather than failing every request trying to reach a
// collector that isn't there.
//
// VERIFIED against a live run, not assumed: auto-instrumentation here only actually
// produces spans for Node's own core modules (http, net) — confirmed by inspecting real
// traces in Jaeger. `pg`, `kafkajs`, `minio` (the S3 client rustfs traffic rides on), and
// `iovalkey` are all userland packages this app reaches via ESM `import`, and each ships an
// instrumentation that patches its target by hooking require()/import() at module-load
// time (require-in-the-middle / import-in-the-middle). Under Bun that hook does not fire
// for these — http/net still get traced because those instrumentations patch the core
// module object directly rather than relying on the load hook. Rather than depend on
// that hook working, db.ts/kafka.ts/storage.ts/valkey.ts each wrap their own calls in a
// manual span using the `tracer` exported below — see the comments there.
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Shared tracer for the manual spans in db.ts/kafka.ts/storage.ts/valkey.ts (see the comment
// block below on why those need manual spans instead of auto-instrumentation).
// trace.getTracer() is safe to call even when the SDK below never starts (no
// OTEL_EXPORTER_OTLP_ENDPOINT) — the API package always has a working no-op tracer
// registered as a fallback, so every span.startSpan()/end() call site elsewhere in the
// gateway stays branch-free instead of needing its own "is otel on?" check.
export const tracer = trace.getTracer("strudel-point-gateway");

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    // `resourceFromAttributes` (the newer factory function) doesn't exist yet on the 1.x
    // line of @opentelemetry/resources this package.json pins (^1.28.0) — it's a
    // @opentelemetry/resources@2.x API. `new Resource({...})` is the constructor 1.x
    // actually ships, and is what this needs to stay on until/unless that pin is
    // deliberately bumped to 2.x (a bigger jump than fixing this one call warrants).
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "strudel-point-gateway",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and low-value here: every static asset / hot-reload probe becomes a
        // span for no benefit. http/express/pg/ws instrumentation (what we actually
        // want — API routes, DB queries, WS handling) stays on by default.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.log(`otel: exporting traces to ${otlpEndpoint}`);

  const shutdown = () => sdk.shutdown().catch((err) => console.error("otel shutdown failed", err));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.log("otel: OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled");
}
