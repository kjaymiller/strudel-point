// @strudel/web ships no types — same ambient declaration as apps/web/src/strudel-web.d.ts,
// trimmed to just what this app calls.
declare module "@strudel/web" {
  export interface StrudelHap {
    /** `{s, n?, ...}` — the sample/synth name (+ bank index) this hap plays, same shape
     * PadGrid/previewSample already decompose refs into. */
    value: Record<string, unknown>;
    /** True while `currentTime` falls within this hap's span — the "is this sounding right now" check. */
    isActive(currentTime: number): boolean;
  }

  export interface StrudelPattern {
    /**
     * Attaches a self-driving requestAnimationFrame loop that queries this pattern
     * against the shared audio clock and calls `onFrame(haps, time)` every frame — haps
     * accumulated over [time - lookbehind, time + lookahead]. Calling `.draw()` again
     * with the same `id` (default 1) cancels the previous loop for that id — used here so
     * playing the rack/a recording/a loaded track again supersedes the previous
     * visualization loop instead of stacking a second one on top of it (see App.tsx's
     * PAD_TRACK_DRAW_ID).
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
  export function evaluate(code: string, autoplay?: boolean): Promise<StrudelPattern | undefined>;
  export function hush(): void;
  export function samples(
    source: string | Record<string, string | string[]>,
    baseUrl?: string,
    options?: { tag?: string },
  ): Promise<unknown>;
  export function aliasBank(source: string | Record<string, string | string[]>): Promise<unknown>;
  export function getAudioContext(): AudioContext;

  /** Registers the built-in synth waveforms (sine/square/sawtooth/etc) as playable
   * sounds — same registry as sample banks, just backed by an oscillator instead of a
   * decoded buffer. Costs nothing to await (no network fetch). */
  export function registerSynthSounds(): Promise<unknown>;
  /** Registers the ZzFX one-line synth sound set (8-bit/chiptune-ish blips) the same way. */
  export function registerZZFXSounds(): Promise<unknown>;

  export interface SoundEntry {
    onTrigger: unknown;
    data?: {
      type?: "sample" | "synth" | string;
      tag?: string;
      samples?: string[] | Record<string, string[]>;
    };
  }

  /** nanostores `map()` store — the live registry of every registered sound name, same
   * shape as apps/web/src/strudel-web.d.ts's copy (see strudel.ts's
   * listRegisteredSounds). */
  export const soundMap: {
    get(): Record<string, SoundEntry>;
    listen(cb: (value: Record<string, SoundEntry>) => void): () => void;
    setKey(key: string, value: SoundEntry | undefined): void;
  };
  /**
   * Directly schedules one sound through superdough's synth/sample engine, bypassing the
   * pattern scheduler entirely — used for pad triggers and sample-shelf previews so hitting
   * a pad never disturbs whatever pattern (if any) is playing elsewhere in the room.
   * `value` needs at least `{ s: name }` (add `n` for a bank slice, e.g. `{ s: "kicks", n:
   * 2 }`); `t` is the absolute AudioContext time to fire at; `hapDuration` is in seconds.
   */
  export function superdough(
    value: Record<string, unknown>,
    t: number,
    hapDuration: number,
    cps?: number,
    cycle?: number,
  ): Promise<unknown>;
}
