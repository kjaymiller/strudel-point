// Shared drag-and-drop payload contracts for the "library tray" (see LibraryTray.tsx) —
// one canonical shape per app, rather than each app inventing its own MIME type and
// payload fields for the same drag. `text/plain` is always set too, alongside the typed
// MIME, so a drop onto anything that only understands plain text (or an external target)
// still gets a sensible name.
//
// This only ever works *within one page* — HTML5 drag-and-drop is scoped to a single top-
// level browsing context, so dragging from one app's own browser tab into a different
// app's separate tab isn't possible no matter what payload shape is used. What this buys
// is: every app that renders <LibraryTray> produces (and reads) the exact same drag data,
// so a Sampler in patch-panel, a pad in pads, or the code editor in web can all accept a
// drop from their own copy of the tray without each inventing their own contract.

export const SOUND_DND_MIME = "application/x-strudel-point-sound";
export const TRACK_DND_MIME = "application/x-strudel-point-track";

export interface SoundDragPayload {
  /** The playable name — what gets passed to `s("<name>")` or dropped into a sampleName
   * field. For a bank slice this is already `bankName:bankIndex` (see banks.ts's
   * playableName), not the row's own internal storage name. */
  name: string;
  /** Present only for custom samples that have decodable audio (absent for built-in
   * sounds, which have no single fetchable URL of their own). */
  url?: string;
  /** Human label for wherever the drop target wants to display it; falls back to `name`. */
  label?: string;
}

export interface TrackDragPayload {
  id: string;
  title: string;
  /** The track's own Strudel source — included so a drop target that wants to *use* the
   * pattern (not just remember which track it was) doesn't need a second fetch. */
  code: string;
}

export function setSoundDragData(e: React.DragEvent, payload: SoundDragPayload): void {
  e.dataTransfer.setData(SOUND_DND_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", payload.name);
  e.dataTransfer.effectAllowed = "copy";
}

export function getSoundDragData(e: React.DragEvent): SoundDragPayload | null {
  const raw = e.dataTransfer.getData(SOUND_DND_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.name === "string") return parsed;
    } catch {
      // fall through to the plain-text fallback below
    }
  }
  // apps/pads' existing sample-shelf chips predate this contract and only ever set bare
  // "text/plain" (a bank name, or "bankName:index" for one slice — see
  // apps/pads/src/components/SampleShelf.tsx) — read that too, rather than requiring
  // every existing drag source to be rewritten just to interoperate with a drop target
  // that reads this helper.
  const plain = e.dataTransfer.getData("text/plain").trim();
  return plain ? { name: plain } : null;
}

export function setTrackDragData(e: React.DragEvent, payload: TrackDragPayload): void {
  e.dataTransfer.setData(TRACK_DND_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", payload.title);
  e.dataTransfer.effectAllowed = "copy";
}

export function getTrackDragData(e: React.DragEvent): TrackDragPayload | null {
  const raw = e.dataTransfer.getData(TRACK_DND_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.id === "string" && typeof parsed?.code === "string") return parsed;
  } catch {
    // fall through
  }
  return null;
}
