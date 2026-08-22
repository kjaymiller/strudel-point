// A user-uploaded audio one-shot/loop, registered into Strudel by `name` (e.g. s("myclap")).
// Distinct from Track: this is a binary asset, not source code, and is scoped to a channel
// so everyone in the room can hear it once one person drops it in.

export interface CustomSample {
  id: string;
  channelId: string;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Where the raw audio bytes live — pass straight to `samples({ [name]: url })`. */
  url: string;
  /**
   * Set when this row is one slice of a beat cut up by the sample analyzer (see
   * BeatAnalyzer.tsx). All rows sharing a `bankName` are meant to be registered together as
   * one Strudel bank — `samples({ [bankName]: urls_sorted_by_bankIndex })` — so they play back
   * as `s("bankName:0")`, `s("bankName:1")`, etc. `name` is still unique per row (needed for
   * storage/lookup); `bankName`/`bankIndex` are purely about how they group for playback.
   */
  bankName?: string;
  bankIndex?: number;
}

/**
 * Builds the audio URL for a sample row, stamped with a version token.
 *
 * The stamp is load-bearing. Re-uploading under an existing name upserts on
 * (channel_id, name), which keeps the row's id and replaces the bytes — so the unstamped
 * URL is byte-for-byte identical before and after an edit while what it serves is not.
 * Two independent caches then keep handing back the old audio:
 *
 *   1. @strudel/webaudio memoises the *decoded* AudioBuffer in a Map keyed by URL, so an
 *      edited sample keeps playing its previous audio for the life of the page. No HTTP
 *      request is issued at all, which is why response headers alone cannot fix this.
 *   2. GET /api/samples/:id/audio replies `cache-control: private, max-age=3600`, so even
 *      a reload can serve the browser's stale copy for up to an hour.
 *
 * `createdAt` is the right token: the upsert sets it to now() on every update, so it moves
 * exactly when the bytes move and never otherwise. Keep this the single place the URL is
 * built — a second, unstamped construction anywhere would silently reintroduce the bug.
 */
export function sampleAudioUrl(id: string, createdAt: string | Date): string {
  return `/api/samples/${id}/audio?v=${new Date(createdAt).getTime()}`;
}
