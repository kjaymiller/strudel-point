import { WebSocket } from "ws";
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

/** Peer counts for every room with at least one client on *this* gateway instance. */
export function listRoomCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [channelId, room] of rooms) counts.set(channelId, room.size);
  return counts;
}

export type { Client };
