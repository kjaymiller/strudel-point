import { Router } from "express";
import type { StrudelJson } from "@strudel-point/shared";
import { asyncHandler } from "../asyncHandler.js";
import { readAutosave, writeAutosave } from "../autosaveBuffer.js";

export const autosaveRouter = Router();

// Both handlers go through autosaveBuffer.ts rather than touching `pool` directly: writes
// buffer in Valkey and drain to Postgres on an interval, reads come from whichever has it.
// See that file's header for why autosave specifically is allowed to be buffered.

// GET /api/channels/:channelId/autosave -> AutosaveDoc | null
autosaveRouter.get(
  "/channels/:channelId/autosave",
  asyncHandler(async (req, res) => {
    res.json(await readAutosave(req.params.channelId));
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
    res.json(await writeAutosave(req.params.channelId, body.code, body.strudelJson));
  }),
);
