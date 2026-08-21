import type { Channel, Presence } from "@strudel-point/shared";
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool } from "../db.js";
import { listPeers, peerCounts } from "../presence.js";

export const channelsRouter = Router();

// GET /api/channels -> Channel[], most recently active first.
// peerCount now comes from the Valkey-backed roster (presence.ts), so it counts peers on
// every gateway instance rather than only this one — one pipelined round trip for the whole
// page of channels. Falls back to this instance's own sockets if Valkey is unreachable.
channelsRouter.get(
  "/channels",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, created_at, last_active_at from channels order by last_active_at desc limit 100`,
    );
    const counts = await peerCounts(rows.map((row) => row.id));
    const channels: Channel[] = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      peerCount: counts.get(row.id) ?? 0,
    }));
    res.json(channels);
  }),
);

// GET /api/channels/:channelId/presence -> Presence
// The roster a client fetches on join, so it knows who's *already* in the room — the
// `user:joined` event stream alone only ever covers arrivals after you connect.
channelsRouter.get(
  "/channels/:channelId/presence",
  asyncHandler(async (req, res) => {
    const presence: Presence = {
      channelId: req.params.channelId,
      peers: await listPeers(req.params.channelId),
    };
    res.json(presence);
  }),
);
