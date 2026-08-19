import { Router } from "express";
import type { CreateTrackInput, Track, UpdateTrackInput } from "@strudel-point/shared";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";

export const tracksRouter = Router();

function rowToTrack(row: any): Track {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    author: row.author,
    code: row.code,
    strudelJson: row.strudel_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/channels/:channelId/tracks
tracksRouter.get(
  "/channels/:channelId/tracks",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `select * from tracks where channel_id = $1 order by created_at desc`,
      [req.params.channelId],
    );
    res.json(rows.map(rowToTrack));
  }),
);

// GET /api/tracks/:id
tracksRouter.get(
  "/tracks/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`select * from tracks where id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rowToTrack(rows[0]));
  }),
);

// POST /api/tracks
tracksRouter.post(
  "/tracks",
  asyncHandler(async (req, res) => {
    const body = req.body as Partial<CreateTrackInput>;
    if (!body.channelId || !body.code || !body.strudelJson) {
      return res.status(400).json({ error: "channelId, code, and strudelJson are required" });
    }
    const { rows } = await pool.query(
      `insert into tracks (channel_id, title, author, code, strudel_json)
       values ($1, $2, $3, $4, $5::jsonb)
       returning *`,
      [
        body.channelId,
        body.title ?? "untitled",
        body.author ?? null,
        body.code,
        JSON.stringify(body.strudelJson),
      ],
    );
    res.status(201).json(rowToTrack(rows[0]));
  }),
);

// PUT /api/tracks/:id — partial update; only fields present in the body are changed.
// `author` may be explicitly set to null to clear it, so it's tracked separately from
// "not provided" rather than folded into a coalesce().
tracksRouter.put(
  "/tracks/:id",
  asyncHandler(async (req, res) => {
    const body = req.body as UpdateTrackInput;
    const sets: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      values.push(body.title);
      sets.push(`title = $${values.length + 1}`);
    }
    if ("author" in body) {
      values.push(body.author ?? null);
      sets.push(`author = $${values.length + 1}`);
    }
    if (body.code !== undefined) {
      values.push(body.code);
      sets.push(`code = $${values.length + 1}`);
    }
    if (body.strudelJson !== undefined) {
      values.push(JSON.stringify(body.strudelJson));
      sets.push(`strudel_json = $${values.length + 1}::jsonb`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: "nothing to update" });
    }

    const { rows } = await pool.query(
      `update tracks set ${sets.join(", ")} where id = $1 returning *`,
      [req.params.id, ...values],
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rowToTrack(rows[0]));
  }),
);

// DELETE /api/tracks/:id
tracksRouter.delete(
  "/tracks/:id",
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(`delete from tracks where id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  }),
);
