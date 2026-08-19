// @strudel/web ships no types; it exposes just enough surface for embedding.
declare module "@strudel/web" {
  export interface StrudelHap {
    whole: { begin: number };
    /** True while `currentTime` falls within this hap's span — the "is this sounding right now" check. */
    isActive(currentTime: number): boolean;
    hasOnset(): boolean;
    context: {
      /** Character offsets into the exact source string that was evaluated — one per
       * mini-notation token contributing to this hap. Set via Pattern#withLoc, deep in
       * @strudel/mini's parser. This is what makes inline highlighting possible. */
      locations?: Array<{ start: number; end: number }>;
    };
  }

  export interface StrudelPattern {
    /**
     * Attaches a self-driving requestAnimationFrame loop that queries this pattern
     * against the shared audio clock and calls `onFrame(haps, time)` every frame — haps
     * accumulated over [time - lookbehind, time + lookahead]. Calling `.draw()` again
     * with the same `id` (default 1) cancels the previous loop for that id, which is how
     * re-evaluating naturally supersedes the highlight loop tied to the old pattern.
     */
    draw(
      onFrame: (haps: StrudelHap[], time: number) => void,
      options?: { lookbehind?: number; lookahead?: number; id?: number },
    ): StrudelPattern;
  }

  export function initStrudel(options?: {
    prebake?: () => Promise<unknown>;
    [key: string]: unknown;
  }): Promise<void>;
  /** Returns the evaluated Pattern (for chaining `.draw()` onto), or undefined on a syntax/eval error. */
  export function evaluate(code: string, autoplay?: boolean): Promise<StrudelPattern | undefined>;
  export function hush(): void;
  /**
   * Loads a sample pack (from a github: shorthand, a JSON manifest URL, or a name -> url
   * map). A value can be a single url (one-shot) or an array of urls (a "bank" — played
   * back as s("name:0"), s("name:1"), etc).
   */
  export function samples(
    source: string | Record<string, string | string[]>,
    baseUrl?: string,
    options?: { tag?: string },
  ): Promise<unknown>;

  /**
   * Registers short aliases (e.g. "tr909") for already-loaded bank names (e.g.
   * "RolandTR909") so `.bank("tr909")` resolves the same as `.bank("RolandTR909")`. Only
   * aliases sounds that are already registered at call time — must run after the
   * `samples()` call for the pack it's aliasing, not in parallel with it.
   */
  export function aliasBank(source: string | Record<string, string | string[]>): Promise<unknown>;

  /** Registers the built-in synth waveforms (sine/square/sawtooth/etc, gm-style names) as
   * playable sounds — same registry as sample banks, just backed by an oscillator instead
   * of a decoded buffer. Part of strudel.cc's own prebake; costs nothing to await (no
   * network fetch), unlike the sample-pack calls below. */
  export function registerSynthSounds(): Promise<unknown>;
  /** Registers the ZzFX one-line synth sound set (8-bit/chiptune-ish blips) the same way. */
  export function registerZZFXSounds(): Promise<unknown>;

  export interface SoundEntry {
    onTrigger: unknown;
    data?: {
      type?: "sample" | "synth" | string;
      tag?: string;
      /** Array form: indexed by `n` directly. Object form (multisampled instruments): keyed
       * by note name, each value its own array, picked by nearest pitch — see
       * getSampleInfo() below, which handles both. */
      samples?: string[] | Record<string, string[]>;
    };
  }

  /** nanostores `map()` store — the live registry of every registered sound name. */
  export const soundMap: {
    get(): Record<string, SoundEntry>;
    listen(cb: (value: Record<string, SoundEntry>) => void): () => void;
    /** Setting a key to `undefined` deletes it (see nanostores' map() source) — this is
     * how a renamed bank's old name gets cleared instead of lingering as a stale entry. */
    setKey(key: string, value: SoundEntry | undefined): void;
  };

  /** Case-insensitive lookup into `soundMap` — same registry, just what superdough itself
   * uses internally to resolve a name at trigger time. */
  export function getSound(name: string): SoundEntry | undefined;
  /**
   * Resolves a hap's `{s, n}` against a bank (an entry's `data.samples`) to the actual
   * sample URL that would play — the same resolution superdough runs on every trigger
   * (index wrap for array banks, nearest-pitch key for multisampled ones). Only `url` is
   * relevant to buffer analysis; the rest (transpose/playbackRate/etc.) is playback-only.
   */
  export function getSampleInfo(
    hapValue: { s: string; n?: number; note?: string | number },
    bank: string[] | Record<string, string[]>,
  ): { transpose: number; url: string; index: number; midi: number; label: string };
  /**
   * Fetches + decodes a sample URL, or returns the already-decoded buffer from cache if
   * something already triggered (or analyzed) this exact URL before. `label`/`n` are only
   * used for log messages.
   */
  export function loadBuffer(url: string, ac: AudioContext, label?: string, n?: number): Promise<AudioBuffer>;

  /** The shared AudioContext every sound in the app plays through. */
  export function getAudioContext(): AudioContext;
  /**
   * Directly schedules one sound through superdough's synth/sample engine, bypassing the
   * pattern scheduler entirely — used for one-shot previews so clicking a sound doesn't
   * touch (or stop) whatever pattern is currently looping. `value` needs at least
   * `{ s: name }`; `t` is the absolute AudioContext time to fire at (superdough silently
   * no-ops with a console warning if `t < ac.currentTime`); `hapDuration` is in seconds.
   */
  export function superdough(
    value: Record<string, unknown>,
    t: number,
    hapDuration: number,
    cps?: number,
    cycle?: number,
  ): Promise<unknown>;
  /**
   * The active output controller. `.output.destinationGain` (note: nested under
   * `.output`, a SuperdoughOutput instance — not a direct property of the controller
   * itself) is the final GainNode before `audioContext.destination`, i.e. the sum of
   * everything currently playing, sample or synth alike, from any pattern. Tap it with
   * your own AnalyserNode (in addition to, not instead of, its existing connection) for a
   * "what's actually coming out of the speakers" visualization — see LiveWaveform.tsx.
   */
  export function getSuperdoughAudioController():
    | { output: { destinationGain: AudioNode | null } | null }
    | undefined;
}
