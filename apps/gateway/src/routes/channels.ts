import { Router } from "express";
import type { Channel } from "@strudel-point/shared";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";
import { listRoomCounts } from "../rooms.js";

export const channelsRouter = Router();

// GET /api/channels -> Channel[], most recently active first.
// peerCount is best-effort: only clients connected to *this* gateway instance, same
// caveat as everywhere else presence shows up (see README).
channelsRouter.get(
  "/channels",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, created_at, last_active_at from channels order by last_active_at desc limit 100`,
    );
    const counts = listRoomCounts();
    const channels: Channel[] = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      peerCount: counts.get(row.id) ?? 0,
    }));
    res.json(channels);
  }),
);
