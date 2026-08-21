// @strudel/soundfonts ships no types. Only used for its one entry point: registering
// General MIDI-style instrument sounds (piano/gm_epiano1/gm_violin/etc, soundfont2-backed)
// into the same soundMap @strudel/web's samples()/registerSynthSounds() write to.
declare module "@strudel/soundfonts" {
  /** Fetches the instrument list and registers each as a playable sound, lazily loading
   * the actual soundfont2 data (and decoding per-note) on first trigger rather than up
   * front — see strudel.ts's prebake for why this is dynamically imported. */
  export function registerSoundfonts(): Promise<unknown>;
}
