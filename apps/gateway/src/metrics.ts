// Prometheus metrics, separate from telemetry.ts's OpenTelemetry traces (see that
// file's own comments for why traces need manual spans under Bun) — different
// signal, different sink: this is scraped by the `prometheus` compose service, not
// pushed anywhere, so unlike telemetry.ts there's no endpoint/env-var gate here.
// Registering a Counter always works, the /metrics route below always has something
// to return, and prometheus.yml simply won't have anyone to scrape if this service
// isn't running (same as any other scrape target).
import { Counter, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests handled, by method/route/status",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// Distinct from a raw status-code count: this is "did the errorHandler in index.ts
// actually catch a thrown/rejected error", which is what actually indicates a bug
// worth alerting on (as opposed to, say, an expected 404 or 400).
export const httpErrorsTotal = new Counter({
  name: "gateway_http_errors_total",
  help: "Total HTTP requests that ended in the errorHandler catching an error",
  labelNames: ["route"] as const,
  registers: [registry],
});

// Every ws.send() call, direct (join ack, error reply) or fanned out through
// rooms.ts's broadcastToChannel — "messages sent" as the user actually experiences
// it, one increment per socket a message actually went out on.
export const wsMessagesSentTotal = new Counter({
  name: "gateway_ws_messages_sent_total",
  help: "Total WebSocket messages sent to clients",
  registers: [registry],
});

export const wsMessagesReceivedTotal = new Counter({
  name: "gateway_ws_messages_received_total",
  help: "Total WebSocket messages received from clients, by message type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const wsErrorsTotal = new Counter({
  name: "gateway_ws_errors_total",
  help: "Total errors thrown while handling an inbound WebSocket message",
  registers: [registry],
});

export const kafkaMessagesPublishedTotal = new Counter({
  name: "gateway_kafka_messages_published_total",
  help: "Total channel events published to Kafka",
  registers: [registry],
});

export const kafkaMessagesConsumedTotal = new Counter({
  name: "gateway_kafka_messages_consumed_total",
  help: "Total channel events consumed from Kafka",
  registers: [registry],
});

export const kafkaErrorsTotal = new Counter({
  name: "gateway_kafka_errors_total",
  help: "Total Kafka publish/consume failures, by operation",
  labelNames: ["operation"] as const,
  registers: [registry],
});

export const valkeyCommandsTotal = new Counter({
  name: "gateway_valkey_commands_total",
  help: "Total Valkey commands that succeeded, by logical operation",
  labelNames: ["operation"] as const,
  registers: [registry],
});

// Every increment here is a request that silently took the degraded path (in-memory
// presence, or a write-through to Postgres) rather than failing — see withValkey in
// valkey.ts. A nonzero rate is the only outward sign of that, which is why it's a metric
// and not just a log line.
export const valkeyErrorsTotal = new Counter({
  name: "gateway_valkey_errors_total",
  help: "Total Valkey command failures that fell back, by logical operation",
  labelNames: ["operation"] as const,
  registers: [registry],
});

export const autosaveFlushesTotal = new Counter({
  name: "gateway_autosave_flushes_total",
  help: "Total buffered autosaves persisted from Valkey to Postgres",
  registers: [registry],
});

// Distinct from valkeyErrorsTotal: this is the *Postgres* half of the flush failing, which
// means a buffered edit got requeued and is still only in Valkey.
export const autosaveFlushErrorsTotal = new Counter({
  name: "gateway_autosave_flush_errors_total",
  help: "Total buffered autosaves that failed to persist and were requeued",
  registers: [registry],
});
