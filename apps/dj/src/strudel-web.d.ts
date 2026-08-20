// @strudel/web ships no types — same ambient declaration as apps/web/src/strudel-web.d.ts,
// trimmed to just what this app calls (no draw()/soundMap/output-tap needed here).
declare module "@strudel/web" {
  /** What initStrudel() actually resolves to — the underlying repl, not void. Only
   * `setCps` is typed here (see strudel.ts's setcps() shim, the reason this app needs
   * the repl at all); the rest of its real shape (scheduler, evaluate, start/stop/pause,
   * ...) isn't something this app calls directly. */
  export interface StrudelRepl {
    setCps(cps: number): void;
  }

  export function initStrudel(options?: {
    prebake?: () => Promise<unknown>;
    [key: string]: unknown;
  }): Promise<StrudelRepl>;
  export function evaluate(code: string, autoplay?: boolean): Promise<unknown>;
  export function hush(): void;
  export function samples(
    source: string | Record<string, string | string[]>,
    baseUrl?: string,
    options?: { tag?: string },
  ): Promise<unknown>;
  export function aliasBank(source: string | Record<string, string | string[]>): Promise<unknown>;
  export function getAudioContext(): AudioContext;
  /**
   * Current position of the shared scheduler, in fractional cycles since transport start —
   * the same clock @strudel/core's Pattern#draw (and setTime, wired up inside initStrudel)
   * reads from. Since deckPattern's `<slice0 slice1 ...>` mini-notation advances one slice
   * per whole cycle, `Math.floor(getTime()) % slices.length` is exactly which slice is
   * currently sounding, and `getTime() % 1` is how far into it — see playheadFor() in
   * App.tsx. Returns 0 before anything has ever played.
   */
  export function getTime(): number;

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
    setKey(key: string, value: SoundEntry | undefined): void;
  };

  /** Directly schedules one sound through superdough's synth/sample engine, bypassing
   * the pattern scheduler entirely — used here only for library-tray sound previews
   * (see App.tsx's previewLibrarySound), never for deck playback itself. */
  export function superdough(
    value: Record<string, unknown>,
    t: number,
    hapDuration: number,
    cps?: number,
    cycle?: number,
  ): Promise<unknown>;
}
