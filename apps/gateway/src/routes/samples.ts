import type { CustomSample } from "@strudel-point/shared";
import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler.js";
import { pool } from "../db.js";
import { deleteSampleBytes, getSampleBytes, putSampleBytes, sampleExists } from "../storage.js";

export const samplesRouter = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — real object storage (MinIO), not a RAM cache
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Strudel sample names end up as bare identifiers in code (s("myclap")) — keep them safe.
// Exported for routes/stems.ts, which validates the same way before deriving per-stem names.
export const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Exported for routes/stems.ts — stem separation inserts custom_samples rows through the
// exact same shape, so it reuses this mapper rather than drifting its own copy.
export function rowToSample(row: any): CustomSample {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/samples/${row.id}/audio`,
    bankName: row.bank_name ?? undefined,
    bankIndex: row.bank_index ?? undefined,
  };
}

// GET /api/channels/:channelId/samples
// Self-cleaning: any row whose cached bytes have expired gets deleted here rather than
// lingering as a dead entry in the list — metadata and cache stay in sync without a
// separate cleanup job.
samplesRouter.get(
  "/channels/:channelId/samples",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `select * from custom_samples where channel_id = $1 order by created_at desc`,
      [req.params.channelId],
    );

    const alive: typeof rows = [];
    const expiredIds: string[] = [];
    await Promise.all(
      rows.map(async (row) => {
        if (await sampleExists(row.id)) alive.push(row);
        else expiredIds.push(row.id);
      }),
    );

    if (expiredIds.length > 0) {
      await pool.query(`delete from custom_samples where id = any($1::uuid[])`, [expiredIds]);
    }

    res.json(alive.map(rowToSample));
  }),
);

// POST /api/channels/:channelId/samples  (multipart/form-data: file, name)
samplesRouter.post(
  "/channels/:channelId/samples",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    const name = (req.body?.name || "").trim();
    if (!file) return res.status(400).json({ error: "file is required" });
    if (!NAME_PATTERN.test(name)) {
      return res.status(400).json({ error: "name must be 1-64 characters of letters, numbers, _ or -" });
    }

    // Optional: this row is one slice of a bank (see BeatAnalyzer.tsx) — bankName follows
    // the same charset as name, bankIndex is its position (s("bankName:bankIndex")).
    const bankNameRaw = (req.body?.bankName || "").trim();
    if (bankNameRaw && !NAME_PATTERN.test(bankNameRaw)) {
      return res.status(400).json({ error: "bankName must be 1-64 characters of letters, numbers, _ or -" });
    }
    const bankName = bankNameRaw || null;
    const bankIndex = bankName === null ? null : Number.parseInt(req.body?.bankIndex, 10);
    if (bankName !== null && !Number.isInteger(bankIndex)) {
      return res.status(400).json({ error: "bankIndex is required when bankName is set" });
    }

    const { rows } = await pool.query(
      `insert into custom_samples (channel_id, name, file_name, mime_type, size_bytes, bank_name, bank_index)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (channel_id, name) do update
         set file_name = excluded.file_name,
             mime_type = excluded.mime_type,
             size_bytes = excluded.size_bytes,
             bank_name = excluded.bank_name,
             bank_index = excluded.bank_index,
             created_at = now()
       returning *`,
      [req.params.channelId, name, file.originalname, file.mimetype, file.size, bankName, bankIndex],
    );
    await putSampleBytes(rows[0].id, file.buffer);
    res.status(201).json(rowToSample(rows[0]));
  }),
);

// GET /api/samples/:id/audio — raw bytes, for Strudel's `samples({ name: url })` to fetch
samplesRouter.get(
  "/samples/:id/audio",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`select mime_type from custom_samples where id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "not found" });

    const data = await getSampleBytes(req.params.id);
    if (!data) {
      // Bucket lifecycle rule expired the object but the metadata row hadn't been swept
      // yet — clean it up now.
      await pool.query(`delete from custom_samples where id = $1`, [req.params.id]);
      return res.status(404).json({ error: "this sample expired after 24h — drop it in again" });
    }

    res.setHeader("content-type", rows[0].mime_type);
    res.setHeader("cache-control", "private, max-age=3600");
    res.send(data);
  }),
);

// PUT /api/channels/:channelId/banks/:bankName/rename  { newName }
// Renames every slice sharing this bankName in one go — the "parent dir" rename. Doesn't
// touch each slice's own `name` (still needs to be unique per (channelId, name); nothing
// about that changes here), only the shared bank_name they're grouped under.
samplesRouter.put(
  "/channels/:channelId/banks/:bankName/rename",
  asyncHandler(async (req, res) => {
    const { channelId, bankName: oldName } = req.params;
    const newName = (req.body?.newName || "").trim();
    if (!NAME_PATTERN.test(newName)) {
      return res.status(400).json({ error: "newName must be 1-64 characters of letters, numbers, _ or -" });
    }
    if (newName === oldName) {
      const { rows } = await pool.query(
        `select * from custom_samples where channel_id = $1 and bank_name = $2`,
        [channelId, oldName],
      );
      return res.json(rows.map(rowToSample));
    }

    // newName must not collide with anything else already playable under that name —
    // another bank, or a standalone (non-bank) sample — since Strudel's soundMap is a
    // flat namespace and a collision would silently make one shadow the other.
    const { rows: collisions } = await pool.query(
      `select 1 from custom_samples where channel_id = $1 and (name = $2 or bank_name = $2) limit 1`,
      [channelId, newName],
    );
    if (collisions.length > 0) {
      return res.status(409).json({ error: `"${newName}" is already in use in this channel` });
    }

    const { rows } = await pool.query(
      `update custom_samples set bank_name = $2 where channel_id = $1 and bank_name = $3 returning *`,
      [channelId, newName, oldName],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `no bank named "${oldName}" found` });
    }
    res.json(rows.map(rowToSample));
  }),
);

// DELETE /api/samples/:id
samplesRouter.delete(
  "/samples/:id",
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(`delete from custom_samples where id = $1`, [req.params.id]);
    await deleteSampleBytes(req.params.id);
    if (rowCount === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  }),
);
