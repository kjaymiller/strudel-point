// A room in the `channels` directory (see db/migrations/006_channels.sql) — exists the
// moment someone joins it, independent of whether it has any tracks/autosave/samples yet.

export interface Channel {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  /**
   * Peers connected to *any* gateway instance right now, from the Valkey-backed roster
   * (apps/gateway/src/presence.ts). Degrades to this-instance-only if Valkey is down.
   */
  peerCount: number;
}

/** One member of a channel's roster — see GET /api/channels/:channelId/presence. */
export interface PresencePeer {
  userId: string;
  username: string;
  /**
   * When the gateway last had positive evidence this socket was alive (join, or a
   * heartbeat tick). A peer disappears from the roster ~90s after its last one.
   */
  lastSeenAt: string;
}

/**
 * The full roster for a channel, across every gateway instance. This is what makes a
 * client joining an already-busy room see who's there — `user:joined` events alone only
 * ever told it about peers who arrived *after* it connected.
 */
export interface Presence {
  channelId: string;
  peers: PresencePeer[];
}
