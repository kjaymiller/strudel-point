// Thin re-export of the canonical drag-and-drop contract — see
// @strudel-point/library's dnd.ts for the real implementation, now shared by every
// strudel-point app (this file used to hold its own separate copy). Kept as a local
// module so CustomSamples.tsx/SoundBank.tsx don't need their import
// paths touched.
export { SOUND_DND_MIME, setSoundDragData, getSoundDragData, type SoundDragPayload } from "@strudel-point/library";
