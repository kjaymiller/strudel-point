import "./telemetry.js"; // must be first: patches http/express/pg/ws before they're imported below
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { WebSocket, WebSocketServer } from "ws";
import type { ChannelEvent, ClientMessage } from "@strudel-point/shared";
import { env } from "./env.js";
import { connectKafka, disconnectKafka, publishChannelEvent, runConsumer } from "./kafka.js";
import { connectStorage, disconnectStorage } from "./storage.js";
import { broadcastToChannel, findClient, joinRoom, leaveRoom, type Client } from "./rooms.js";
import { pool } from "./db.js";
import { tracksRouter } from "./routes/tracks.js";
import { autosaveRouter } from "./routes/autosave.js";
import { samplesRouter } from "./routes/samples.js";
import { stemsRouter } from "./routes/stems.js";
import { channelsRouter } from "./routes/channels.js";
import {
  registry,
  httpRequestsTotal,
  httpErrorsTotal,
  wsMessagesSentTotal,
  wsMessagesReceivedTotal,
  wsErrorsTotal,
} from "./metrics.js";

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

// One counter increment per finished response, labeled with the matched route
// pattern (not the raw path, which would blow up cardinality with every distinct
// channelId/sampleId) — req.route is only populated once Express has matched a
// route, so this reads it in the 'finish' listener rather than up front.
app.use((req, res, next) => {
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});
app.use("/api", tracksRouter);
app.use("/api", autosaveRouter);
app.use("/api", samplesRouter);
app.use("/api", stemsRouter);
app.use("/api", channelsRouter);

// Catches everything asyncHandler forwards, plus sync throws and unknown-route 404s
// that Express falls through to. Every /api response is guaranteed JSON from here on —
// nothing hangs or silently 500s with an HTML page the client can't parse.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  console.error("request failed", err);
  httpErrorsTotal.inc({ route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path });
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
};
app.use(errorHandler);

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Tracks which channel each socket is in, so we know where to remove it from on close.
const socketChannel = new Map<WebSocket, string>();

// A socket whose peer vanished without a clean close (laptop sleep, wifi drop, a
// container's network being torn down) can sit in the `wss.clients` set indefinitely —
// TCP alone won't notice for a long time, so it looks "connected" here while the browser
// has already given up and started reconnecting. Ping every 30s and terminate anything
// that didn't pong since the last check, so a truly dead socket gets cleaned up (and the
// client's own reconnect logic gets a fresh, working connection) within one interval
// instead of an indeterminate wait.
const alive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 30_000);

wss.on("connection", (ws) => {
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));

  ws.on("message", async (raw) => {
    try {
      await handleMessage(ws, raw);
    } catch (err) {
      // Otherwise this is an unhandled rejection: the client's send just vanishes with
      // no response at all, and "evaluate"/"save" appear to silently do nothing.
      console.error("failed to handle ws message", err);
      wsErrorsTotal.inc();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : "failed to process message",
          }),
        );
        wsMessagesSentTotal.inc();
      }
    }
  });

  async function handleMessage(ws: WebSocket, raw: unknown) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      throw new Error("received malformed (non-JSON) message");
    }
    wsMessagesReceivedTotal.inc({ type: msg.type });

    if (msg.type === "join") {
      const channelId = msg.channelId;
      const client: Client = { ws, userId: randomUUID(), username: msg.username };
      joinRoom(channelId, client);
      socketChannel.set(ws, channelId);

      // Records the room in the directory (GET /api/channels) the moment anyone joins it,
      // independent of whether it ever gets a saved track/autosave/sample. Fire-and-log
      // rather than awaited: a directory-listing hiccup shouldn't block someone from
      // actually joining the room they came here for.
      pool
        .query(
          `insert into channels (id) values ($1)
           on conflict (id) do update set last_active_at = now()`,
          [channelId],
        )
        .catch((err) => console.error("failed to record channel activity", err));

      // Direct ack (not a Kafka event) so the client learns its own userId and can
      // ignore self-echoed events coming back through the broadcast loop below.
      ws.send(JSON.stringify({ type: "joined", userId: client.userId, channelId }));
      wsMessagesSentTotal.inc();

      await publishChannelEvent({
        type: "user:joined",
        channelId,
        userId: client.userId,
        username: client.username,
        ts: Date.now(),
      });
      return;
    }

    // Every other message type is a channel event: stamp it and publish to Kafka.
    // We do NOT broadcast directly here — the Kafka consumer loop below is the single
    // fan-out path, so behavior is identical whether this instance or another produced it.
    const channelId = socketChannel.get(ws);
    const client = channelId && findClient(channelId, ws);
    if (!channelId || !client) {
      throw new Error("received an event before joining a channel");
    }

    const event = {
      ...msg,
      channelId,
      userId: client.userId,
      ts: Date.now(),
    } as ChannelEvent;

    await publishChannelEvent(event);
  }

  ws.on("close", () => {
    const channelId = socketChannel.get(ws);
    if (!channelId) return;
    const client = findClient(channelId, ws);
    socketChannel.delete(ws);
    if (!client) return;
    leaveRoom(channelId, client);
    publishChannelEvent({
      type: "user:left",
      channelId,
      userId: client.userId,
      username: client.username,
      ts: Date.now(),
    }).catch((err) => console.error("failed to publish user:left", err));
  });
});

async function main() {
  await connectKafka();
  await connectStorage();

  // Fan out every consumed event to whichever clients this instance is holding sockets for.
  // Note: the sender itself will also receive its own event echoed back (simplest correct
  // behavior for a single-buffer model) — the web client is written to no-op on self-echo.
  await runConsumer((event) => {
    broadcastToChannel(event.channelId, event);
  });

  httpServer.listen(env.port, () => {
    console.log(`gateway listening on :${env.port} (ws path: /ws, api: /api)`);
  });
}

main().catch((err) => {
  console.error("gateway failed to start", err);
  process.exit(1);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("shutting down...");
  clearInterval(heartbeat);
  await disconnectKafka();
  await disconnectStorage();
  httpServer.close(() => process.exit(0));
}
