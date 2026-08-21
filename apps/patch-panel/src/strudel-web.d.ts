// @strudel/web ships no types — same ambient declaration as apps/pads/src/strudel-web.d.ts,
// trimmed to just what this app calls.
declare module "@strudel/web" {
  export interface StrudelHap {
    value: Record<string, unknown>;
    isActive(currentTime: number): boolean;
  }

  export interface StrudelPattern {
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
   * registerAllSamples/listRegisteredSounds). */
  export const soundMap: {
    get(): Record<string, SoundEntry>;
    listen(cb: (value: Record<string, SoundEntry>) => void): () => void;
    /** Setting a key to `undefined` deletes it — how a renamed bank's old name gets
     * cleared instead of lingering as a stale entry. */
    setKey(key: string, value: SoundEntry | undefined): void;
  };
  export function getAudioContext(): AudioContext;
  /**
   * The scheduler's current position, in cycles (already scaled by whatever cps is in
   * effect) — the same clock `.scope()`/`.draw()` query internally (see @strudel/core's
   * schedulerState.mjs). Throws if called before initStrudel() has run (it calls
   * `setTime()` internally as part of setup) — see components/SignalGen.tsx for why every
   * call site here goes through a try/catch instead of gating on readiness up front.
   */
  export function getTime(): number;
  /**
   * Directly schedules one sound through superdough's synth engine, bypassing the pattern
   * scheduler entirely — used here so pressing a keyboard key/note previews the current
   * patch instantly without disturbing whatever pattern (if any) is playing elsewhere in
   * the room. `value` needs at least `{ s: waveform, note }`; `t` is the absolute
   * AudioContext time to fire at; `hapDuration` is in seconds.
   */
  export function superdough(
    value: Record<string, unknown>,
    t: number,
    hapDuration: number,
    cps?: number,
    cycle?: number,
  ): Promise<unknown>;
}
