import type { PresencePeer } from "@strudel-point/shared";
import { withValkey, isValkeyReady } from "./valkey.js";
import { listRoomCounts, listRoomPeers } from "./rooms.js";

// Presence is the one thing the Kafka fan-out design can't give us. Every gateway instance
// consumes every event and broadcasts to its own sockets (see kafka.ts's per-instance
// consumer group), which is exactly why no instance knows who's connected to any other —
// rooms.ts is a plain in-process Map. So "who's in this room" was previously both
// instance-local *and* join-order-only: a client learned about peers from `user:joined`
// events, meaning it never saw anyone who was already sitting there before it connected.
//
// A sorted set per channel fixes both at once: scored by last-seen timestamp, so it
// doubles as the liveness reaper for sockets that died without a clean close.
const peersKey = (channelId: string) => `presence:${channelId}:peers`;
const namesKey = (channelId: string) => `presence:${channelId}:names`;

// index.ts pings every 30s and touches presence on the same tick, so three consecutive
// misses is the "this peer is gone" threshold. Deliberately looser than the ws heartbeat's
// own terminate-on-one-miss: a peer briefly missing from the roster is a worse artifact
// (names flickering out of the sidebar) than one lingering an extra minute.
const PEER_TTL_MS = 90_000;

// Backstop for an instance that dies hard (SIGKILL, container OOM) without running its
// close handlers: the keys themselves expire, so a room can't be haunted by peers no
// reaper will ever be asked about. Refreshed on every touch, so it only fires once a
// channel has genuinely gone quiet.
const KEY_TTL_SECONDS = 600;

/**
 * Records (or refreshes) a peer's membership. Called on join and on every heartbeat tick,
 * so the score is always "when we last had positive evidence this socket was alive".
 */
export async function touchPeer(channelId: string, userId: string, username: string) {
  await withValkey(
    "presence.touch",
    async (client) => {
      await client
        .multi()
        .zadd(peersKey(channelId), Date.now(), userId)
        .hset(namesKey(channelId), userId, username)
        .expire(peersKey(channelId), KEY_TTL_SECONDS)
        .expire(namesKey(channelId), KEY_TTL_SECONDS)
        .exec();
    },
    undefined,
  );
}

/** Removes a peer on clean disconnect — the reaper below only exists for unclean ones. */
export async function dropPeer(channelId: string, userId: string) {
  await withValkey(
    "presence.drop",
    async (client) => {
      await client.multi().zrem(peersKey(channelId), userId).hdel(namesKey(channelId), userId).exec();
    },
    undefined,
  );
}

/**
 * The full roster for a channel across every gateway instance, newest-seen first.
 * Falls back to this instance's own sockets when Valkey is down — which is exactly the
 * pre-Valkey behavior, so the feature gets worse rather than breaking.
 */
export async function listPeers(channelId: string): Promise<PresencePeer[]> {
  if (!isValkeyReady()) return listRoomPeers(channelId);

  return withValkey(
    "presence.list",
    async (client) => {
      const cutoff = Date.now() - PEER_TTL_MS;
      // Reap before reading, not on a timer: a stale member is only ever *observed* here,
      // so there's no window in which anyone sees the un-reaped set, and there's no
      // background sweep to run per channel.
      await client.zremrangebyscore(peersKey(channelId), "-inf", cutoff);
      const flat = await client.zrevrange(peersKey(channelId), 0, -1, "WITHSCORES");
      if (flat.length === 0) return [];

      const userIds: string[] = [];
      const seenAt: number[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        userIds.push(flat[i]);
        seenAt.push(Number(flat[i + 1]));
      }
      const names = await client.hmget(namesKey(channelId), ...userIds);

      return userIds.map((userId, i) => ({
        userId,
        // A member in the zset with no name field means its hdel/hset pair raced or the
        // names hash expired first — show the peer rather than dropping them silently.
        username: names[i] ?? "anonymous",
        lastSeenAt: new Date(seenAt[i]).toISOString(),
      }));
    },
    // Fallback covers "ready when we checked, failed mid-command" — same local-only answer.
    listRoomPeers(channelId),
  );
}

/**
 * Peer counts for a batch of channels, for the directory listing. One pipeline rather than
 * N round trips, since GET /api/channels asks about up to 100 channels at once.
 */
export async function peerCounts(channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  if (!isValkeyReady()) return listRoomCounts();

  return withValkey(
    "presence.counts",
    async (client) => {
      const cutoff = Date.now() - PEER_TTL_MS;
      const pipeline = client.pipeline();
      for (const id of channelIds) {
        pipeline.zremrangebyscore(peersKey(id), "-inf", cutoff);
        pipeline.zcard(peersKey(id));
      }
      const results = await pipeline.exec();
      const counts = new Map<string, number>();
      channelIds.forEach((id, i) => {
        // Two commands queued per channel; the zcard result is the second of each pair.
        const [err, value] = results?.[i * 2 + 1] ?? [null, 0];
        counts.set(id, err ? 0 : Number(value ?? 0));
      });
      return counts;
    },
    listRoomCounts(),
  );
}
