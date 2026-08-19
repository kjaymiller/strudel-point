// Shape of a saved track, as stored in Postgres (`tracks` table) and returned by the REST API.

export interface Track {
  id: string;
  channelId: string;
  title: string;
  author: string | null;
  code: string;
  /** Structured document stored in the `strudel_json` jsonb column — see StrudelJson below. */
  strudelJson: StrudelJson;
  createdAt: string;
  updatedAt: string;
}

/**
 * The `strudel.json` document for a track. Mirrors the shape Strudel's own REPL keeps per
 * pattern, so a row here can round-trip into strudel.cc's local pattern store if needed.
 */
export interface StrudelJson {
  code: string;
  /** cycles per second, i.e. tempo, if the pattern set one explicitly */
  cps?: number;
  tags?: string[];
  version: 1;
}

export interface CreateTrackInput {
  channelId: string;
  title: string;
  author?: string;
  code: string;
  strudelJson: StrudelJson;
}

/** Fields that can be changed on an existing track. All optional — send only what changed. */
export interface UpdateTrackInput {
  title?: string;
  author?: string | null;
  code?: string;
  strudelJson?: StrudelJson;
}

/**
 * One autosave slot per channel — unlike a `Track`, this is upserted in place (same row
 * every time), so it doesn't clutter the saved-tracks list. Used to restore a room's
 * buffer if everyone leaves and someone comes back later.
 */
export interface AutosaveDoc {
  channelId: string;
  code: string;
  strudelJson: StrudelJson;
  updatedAt: string;
}

