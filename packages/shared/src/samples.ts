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
