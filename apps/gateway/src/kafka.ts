import { Kafka, logLevel } from "kafkajs";
import { SpanStatusCode } from "@opentelemetry/api";
import { CHANNEL_EVENTS_TOPIC, type ChannelEvent } from "@strudel-point/shared";
import { env } from "./env.js";
import { tracer } from "./telemetry.js";

// kafkajs's own pending-request scheduler occasionally computes a negative setTimeout
// delay under Bun (a runtime clock-arithmetic quirk, not anything about our brokers or
// config — see kafkajs's requestQueue/index.js:scheduleCheckPendingRequests). Node/Bun
// both still fire the timer immediately either way, so this is cosmetic, but left alone
// it spams a multi-line warning on every occurrence — noisy enough to bury the errors
// that actually matter. Filter just this one warning name; everything else still prints.
process.on("warning", (warning) => {
  if (warning.name !== "TimeoutNegativeWarning") console.warn(warning);
});

const kafka = new Kafka({
  clientId: env.kafkaClientId,
  brokers: env.kafkaBrokers,
  logLevel: logLevel.WARN,
  ssl: env.kafkaSsl,
  sasl:
    env.kafkaSaslUsername && env.kafkaSaslPassword
      ? { mechanism: "plain", username: env.kafkaSaslUsername, password: env.kafkaSaslPassword }
      : undefined,
  // Defaults (connectionTimeout 1000ms, 5 retries maxing out at ~5s) are tuned for a
  // production cluster that's normally reachable instantly. A local single-broker KRaft
  // container can take longer to become ready/reachable (especially right after
  // `docker compose up`), and once a connection does drop, a producer/consumer that gives
  // up retrying leaves the whole app looking "disconnected" until the gateway is manually
  // restarted. Retry effectively indefinitely with a capped backoff instead.
  connectionTimeout: 10_000,
  retry: { initialRetryTime: 300, retries: Infinity, maxRetryTime: 30_000 },
});

export const producer = kafka.producer();

// Each gateway instance runs its own consumer group so every instance receives every
// event and can fan it out to whichever clients happen to be connected to *it*. This is
// the deliberate trade for horizontal scaling without a shared-state layer: broadcast,
// not load-balanced, consumption. Fine at this scale; revisit if partition count needs
// to bound consumer count instead.
const consumerGroupId = `${env.kafkaClientId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
export const consumer = kafka.consumer({ groupId: consumerGroupId });

export async function connectKafka() {
  // Create the topic explicitly rather than relying on broker auto-create: it closes a
  // startup race where the consumer subscribes before the topic exists (seen locally
  // against apache/kafka in KRaft mode), and Aiven for Apache Kafka services commonly
  // ship with topic auto-create disabled, so this is required there regardless.
  //
  // Every gateway restart (this is `bun --watch`, so that includes every source-file
  // save) hits this again and the topic already exists from the first run — kafkajs's
  // own logger reports that response as an ERROR-level "Topic creation errors" line
  // regardless (its logger doesn't distinguish "some topics already existed" from a real
  // failure), which reads as something actually being broken on every single reload.
  // createTopics() itself resolves fine either way (it doesn't throw for that case) — the
  // check below just avoids provoking the noisy log path at all when there's nothing to do.
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  if (!existing.includes(CHANNEL_EVENTS_TOPIC)) {
    await admin.createTopics({
      topics: [{ topic: CHANNEL_EVENTS_TOPIC, numPartitions: 6 }],
    });
  }
  await admin.disconnect();

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: CHANNEL_EVENTS_TOPIC, fromBeginning: false });
}

export async function disconnectKafka() {
  await Promise.all([producer.disconnect(), consumer.disconnect()]);
}

// @opentelemetry/instrumentation-kafkajs (bundled by getNodeAutoInstrumentations in
// telemetry.ts) would normally span every produce/consume for free, but — same story as
// pg in db.ts — it hooks kafkajs via a require/import hook that doesn't fire under Bun
// for this ESM import, so producer.send/consumer.run are otherwise invisible in traces.
// Manual spans here cover both sides by hand.
export async function publishChannelEvent(event: ChannelEvent) {
  await tracer.startActiveSpan("kafka.publish", async (span) => {
    span.setAttribute("messaging.system", "kafka");
    span.setAttribute("messaging.destination.name", CHANNEL_EVENTS_TOPIC);
    span.setAttribute("messaging.operation", "publish");
    span.setAttribute("channel.id", event.channelId);
    try {
      await producer.send({
        topic: CHANNEL_EVENTS_TOPIC,
        messages: [{ key: event.channelId, value: JSON.stringify(event) }],
      });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function runConsumer(onEvent: (event: ChannelEvent) => void) {
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      await tracer.startActiveSpan("kafka.consume", async (span) => {
        span.setAttribute("messaging.system", "kafka");
        span.setAttribute("messaging.destination.name", CHANNEL_EVENTS_TOPIC);
        span.setAttribute("messaging.operation", "process");
        try {
          const event = JSON.parse(message.value!.toString("utf8")) as ChannelEvent;
          span.setAttribute("channel.id", event.channelId);
          onEvent(event);
        } catch (err) {
          console.error("failed to parse channel event", err);
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        } finally {
          span.end();
        }
      });
    },
  });
}
