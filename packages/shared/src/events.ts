import type { CustomSample } from "./samples.js";

// Shared event contract between the web client, the WS gateway, and Kafka.
// Every event that crosses a channel boundary is one of these — same shape
// whether it travels client -> gateway (WebSocket) or gateway -> Kafka -> gateway.

export type ChannelEvent =
  | UserJoinedEvent
  | UserLeftEvent
  | DocUpdateEvent
  | EvalEvent
  | CursorEvent
  | ChatMessageEvent
  | SampleAddedEvent
  | SampleRemovedEvent
  | BankRenamedEvent
  | HushEvent;

interface BaseEvent {
  channelId: string;
  userId: string;
  ts: number;
}

export interface UserJoinedEvent extends BaseEvent {
  type: "user:joined";
  username: string;
}

export interface UserLeftEvent extends BaseEvent {
  type: "user:left";
  username: string;
}

/** Full-buffer sync of a pane's source. Simplest possible model (no CRDT) — last write wins per pane. */
export interface DocUpdateEvent extends BaseEvent {
  type: "doc:update";
  paneId: string;
  content: string;
}

/** Someone hit evaluate. Carries the code that was actually run, for the "flash" UI and for history. */
export interface EvalEvent extends BaseEvent {
  type: "eval";
  paneId: string;
  code: string;
}

/** Someone hit hush (stop all sound) — every other client should stop playback too. */
export interface HushEvent extends BaseEvent {
  type: "hush";
  paneId: string;
}

export interface CursorEvent extends BaseEvent {
  type: "cursor";
  paneId: string;
  anchor: number;
  head: number;
}

export interface ChatMessageEvent extends BaseEvent {
  type: "chat:message";
  body: string;
}

/**
 * Someone uploaded a custom sample via REST (multipart upload doesn't fit over the WS
 * JSON protocol), then broadcasts this so everyone else in the room registers/hears it
 * too, without needing to reload.
 */
export interface SampleAddedEvent extends BaseEvent {
  type: "sample:added";
  sample: CustomSample;
}

export interface SampleRemovedEvent extends BaseEvent {
  type: "sample:removed";
  sampleId: string;
  name: string;
}

/**
 * A BeatAnalyzer bank (the shared `bankName` on a group of slices) was renamed — every
 * slice sharing the old name moved to the new one server-side; this tells everyone else
 * in the room to re-register under the new name and drop the old one from their soundMap.
 */
export interface BankRenamedEvent extends BaseEvent {
  type: "bank:renamed";
  oldName: string;
  newName: string;
  /** The affected slices, already updated to the new bankName — saves a refetch. */
  samples: CustomSample[];
}

/**
 * Messages a client can send. `channelId` is deliberately omitted here (beyond `join`) —
 * the gateway already knows which channel a socket joined and stamps it server-side,
 * along with `userId`/`ts`, so a client can't spoof another channel's events.
 */
export type ClientMessage =
  | { type: "join"; channelId: string; username: string }
  | Omit<DocUpdateEvent, "userId" | "ts" | "channelId">
  | Omit<EvalEvent, "userId" | "ts" | "channelId">
  | Omit<CursorEvent, "userId" | "ts" | "channelId">
  | Omit<ChatMessageEvent, "userId" | "ts" | "channelId">
  | Omit<SampleAddedEvent, "userId" | "ts" | "channelId">
  | Omit<SampleRemovedEvent, "userId" | "ts" | "channelId">
  | Omit<BankRenamedEvent, "userId" | "ts" | "channelId">
  | Omit<HushEvent, "userId" | "ts" | "channelId">;
