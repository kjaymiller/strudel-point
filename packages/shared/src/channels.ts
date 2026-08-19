// A room in the `channels` directory (see db/migrations/006_channels.sql) — exists the
// moment someone joins it, independent of whether it has any tracks/autosave/samples yet.

export interface Channel {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  /** Peers connected *to this gateway instance* right now — best-effort, like presence elsewhere. */
  peerCount: number;
}
