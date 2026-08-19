import { Router } from "express";
import type { AutosaveDoc, StrudelJson } from "@strudel-point/shared";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";

export const autosaveRouter = Router();

function rowToAutosave(row: any): AutosaveDoc {
  return {
    channelId: row.channel_id,
    code: row.code,
    strudelJson: row.strudel_json,
    updatedAt: row.updated_at,
  };
}

// GET /api/channels/:channelId/autosave -> AutosaveDoc | null
autosaveRouter.get(
  "/channels/:channelId/autosave",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`select * from autosaves where channel_id = $1`, [
      req.params.channelId,
    ]);
    res.json(rows.length ? rowToAutosave(rows[0]) : null);
  }),
);

// PUT /api/channels/:channelId/autosave { code, strudelJson }
autosaveRouter.put(
  "/channels/:channelId/autosave",
  asyncHandler(async (req, res) => {
    const body = req.body as Partial<{ code: string; strudelJson: StrudelJson }>;
    if (!body.code || !body.strudelJson) {
      return res.status(400).json({ error: "code and strudelJson are required" });
    }
    const { rows } = await pool.query(
      `insert into autosaves (channel_id, code, strudel_json)
       values ($1, $2, $3::jsonb)
       on conflict (channel_id) do update
         set code = excluded.code, strudel_json = excluded.strudel_json
       returning *`,
      [req.params.channelId, body.code, JSON.stringify(body.strudelJson)],
    );
    res.json(rowToAutosave(rows[0]));
  }),
);
