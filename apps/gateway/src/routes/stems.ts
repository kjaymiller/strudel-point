import { Router } from "express";
import multer from "multer";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";
import { putSampleBytes } from "../storage.js";
import { env } from "../env.js";
import { NAME_PATTERN, rowToSample } from "./samples.js";

export const stemsRouter = Router();

// Same cap as samples.ts's own upload route — a whole track being separated is bigger
// than one chopped slice usually is, but it's still one song, not a whole set.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Matches apps/spleeter/server.py's own fixed stem set (the pretrained `spleeter:4stems`
// model always produces exactly these four, in this order) — kept here too so a stem
// missing or misnamed in the Spleeter response fails loudly instead of silently
// inserting whatever keys happened to come back.
const STEM_NAMES = ["vocals", "drums", "bass", "other"] as const;

// POST /api/channels/:channelId/samples/separate  (multipart/form-data: file, name)
// Forwards the uploaded audio to the dedicated Spleeter service (see apps/spleeter),
// then inserts each of the four returned stems as its own ordinary custom_samples row —
// `${name}_vocals`, `${name}_drums`, etc — no different from any other upload once
// they're stored. Slow: real ML inference, not a quick transform, so this is expected to
// take real wall-clock time before it resolves.
stemsRouter.post(
  "/channels/:channelId/samples/separate",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    const baseName = (req.body?.name || "").trim();
    if (!file) return res.status(400).json({ error: "file is required" });
    if (!NAME_PATTERN.test(baseName)) {
      return res
        .status(400)
        .json({ error: "name must be 1-64 characters of letters, numbers, _ or -" });
    }

    const form = new FormData();
    form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);

    let separated: Response;
    try {
      separated = await fetch(`${env.spleeterUrl}/separate`, { method: "POST", body: form });
    } catch (err) {
      // Most likely cause: the spleeter service isn't up (see the docker-compose.yml
      // disclaimer on that service) — surface that plainly rather than a bare "fetch failed".
      throw new Error(
        `couldn't reach the stem-separation service: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!separated.ok) {
      const body = await separated.text().catch(() => "");
      throw new Error(`stem separation failed (${separated.status}): ${body.slice(0, 500)}`);
    }
    const payload = (await separated.json()) as { stems?: Record<string, string> };
    const stems = payload.stems ?? {};
    const missing = STEM_NAMES.filter((n) => !stems[n]);
    if (missing.length > 0) {
      throw new Error(`stem-separation response is missing: ${missing.join(", ")}`);
    }

    const results = [];
    for (const stemName of STEM_NAMES) {
      // `${baseName}_${stemName}` truncated to the same 64-char ceiling every other
      // sample name is held to — a 60-char baseName plus "_vocals" would otherwise
      // silently fail NAME_PATTERN on the way back out through rowToSample's own name
      // field (it doesn't re-validate, but the DB column/Strudel identifier rules still
      // apply), so truncate the *base* rather than the suffix to keep the stem it names
      // legible in the trimmed result.
      const name = `${baseName}_${stemName}`.slice(0, 64);
      const buffer = Buffer.from(stems[stemName], "base64");

      const { rows } = await pool.query(
        `insert into custom_samples (channel_id, name, file_name, mime_type, size_bytes, bank_name, bank_index)
         values ($1, $2, $3, $4, $5, null, null)
         on conflict (channel_id, name) do update
           set file_name = excluded.file_name,
               mime_type = excluded.mime_type,
               size_bytes = excluded.size_bytes,
               bank_name = null,
               bank_index = null,
               created_at = now()
         returning *`,
        [req.params.channelId, name, `${name}.wav`, "audio/wav", buffer.length],
      );
      await putSampleBytes(rows[0].id, buffer);
      results.push(rowToSample(rows[0]));
    }

    res.status(201).json(results);
  }),
);
