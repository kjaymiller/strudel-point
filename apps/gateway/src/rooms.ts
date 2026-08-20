import { WebSocket } from "ws";
import type { PresencePeer } from "@strudel-point/shared";
import { wsMessagesSentTotal } from "./metrics.js";

interface Client {
  ws: WebSocket;
  userId: string;
  username: string;
}

// channelId -> connected clients on *this* gateway instance.
const rooms = new Map<string, Set<Client>>();

export function joinRoom(channelId: string, client: Client) {
  let room = rooms.get(channelId);
  if (!room) {
    room = new Set();
    rooms.set(channelId, room);
  }
  room.add(client);
}

export function leaveRoom(channelId: string, client: Client) {
  const room = rooms.get(channelId);
  if (!room) return;
  room.delete(client);
  if (room.size === 0) rooms.delete(channelId);
}

export function findClient(channelId: string, ws: WebSocket): Client | undefined {
  const room = rooms.get(channelId);
  if (!room) return undefined;
  for (const client of room) {
    if (client.ws === ws) return client;
  }
  return undefined;
}

/** Broadcast to everyone in the channel connected to this instance, optionally skipping the sender. */
export function broadcastToChannel(channelId: string, payload: unknown, exclude?: WebSocket) {
  const room = rooms.get(channelId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const client of room) {
    if (client.ws === exclude) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
      wsMessagesSentTotal.inc();
    }
  }
}

/**
 * Peer counts for every room with at least one client on *this* gateway instance.
 * Only used as presence.ts's fallback now — the accurate cross-instance count lives in
 * Valkey; this is what you get when Valkey is unreachable.
 */
export function listRoomCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [channelId, room] of rooms) counts.set(channelId, room.size);
  return counts;
}

/**
 * This instance's own clients in a channel, shaped like the Valkey-backed roster so
 * presence.ts can fall back to it without the caller noticing a different type.
 * `lastSeenAt` is "now" because a socket held in this map is by definition still open.
 */
export function listRoomPeers(channelId: string): PresencePeer[] {
  const room = rooms.get(channelId);
  if (!room) return [];
  const now = new Date().toISOString();
  return [...room].map((client) => ({
    userId: client.userId,
    username: client.username,
    lastSeenAt: now,
  }));
}

export type { Client };
