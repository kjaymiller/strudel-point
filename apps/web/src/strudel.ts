// Shared @strudel/web singleton — anything that needs to evaluate code, register
// samples, or tap the live audio graph (see LiveWaveform.tsx) imports getStrudel() from
// here, so there's exactly one initStrudel() call and one AudioContext for the whole app.
//
// Loaded lazily: @strudel/web boots a full webaudio graph on import, which browsers
// require to happen from a user gesture — callers should only invoke this from a click
// handler (or similar), not on mount.
//
// initStrudel() on its own only registers synths — per @strudel/web's own docs, "by
// default, no external samples are loaded". Drum-machine names like bd/hh/sd need an
// explicit sample pack, fetched from GitHub on first init (needs network access from
// the browser; there's a beat of latency the first time evaluate/hush is pressed).
//
// This mirrors strudel.cc's own prebake (website/src/repl/prebake.mjs in the strudel
// repo, now at codeberg.org/uzu/strudel) piece for piece, so every sound name that works
// on strudel.cc works here too — just resolved against GitHub-hosted mirrors of the same
// manifests instead of strudel's own CDN (strudel.b-cdn.net), to avoid depending on
// infrastructure this project doesn't control:
// - registerSynthSounds / registerZZFXSounds: no fetch, just registers oscillator-backed
//   waveforms (sine/square/...) and the ZzFX chiptune set into the same sound registry
//   samples() below writes to.
// - registerSoundfonts (@strudel/soundfonts, dynamic-imported): General MIDI-style
//   instruments (gm_epiano1, gm_violin, etc), soundfont2-backed. Dynamic import because
//   the package touches `window` at module-eval time and would throw during any
//   server-side pass over this file (SSR/prerender/test) if imported statically.
// - piano: the Salamander Grand Piano samples — this is where the plain "piano" sound
//   (s("piano")) comes from; strudel.cc's prebake also exposes it as a .piano() pattern
//   method (see the Pattern.prototype.piano patch in its prebake.mjs) but that's a
//   convenience wrapper, not a registration, so it's not reproduced here.
// - vcsl: the VCSL orchestral/world-instrument sample library (sgossner/VCSL).
// - mridangam: South Indian mridangam drum samples (yaxu/mrid).
// - tidal-drum-machines + uzu-drumkit: what .bank(...) resolves against, plus the newer
//   uzu-drumkit pack strudel.cc added alongside it. bank() looks up `${bank}_${s}`
//   (lowercased) — see @strudel/web's sample trigger code — and that naming (keys like
//   "RolandTR909_bd") only exists in these packs, not in dirt-samples.
// - uzu-wavetables: wavetable-synth waveforms (wt_digital/wt_vgame), played via s(...)
//   like any other sample rather than through .bank().
// - dirt-samples: the plain s("bd"), s("hh") etc. sounds.
// - tidal-drum-machines-alias: short names like "tr909"/"909" for the full pack names
//   (here, "RolandTR909"). aliasBank() only works on sounds already registered, so it
//   has to run *after* the tidal-drum-machines/uzu-drumkit samples() calls resolve, not
//   in parallel with them — otherwise there's nothing yet to alias and .bank("tr909")
//   still finds nothing, even though .bank("rolandtr909") (the un-aliased full name)
//   works fine.
let strudelModule: typeof import("@strudel/web") | null = null;

export async function getStrudel() {
  if (!strudelModule) {
    strudelModule = await import("@strudel/web");

    // slider(value, min, max) in evaluated code gets transpiled to sliderWithID(id, ...)
    // (see @strudel/transpiler's isSliderFunction) — but @strudel/web doesn't bundle that
    // runtime piece itself (confirmed: no "sliderWithID" anywhere in its dist bundle),
    // only @strudel/codemirror does, since it's normally paired with the widget that
    // renders the slider. Expose it globally so the transpiled call actually resolves —
    // see Editor.tsx for the widget half of this (sliderPlugin, rendering the knob).
    const { sliderWithID } = await import("@strudel/codemirror/slider.mjs");
    (globalThis as any).sliderWithID = sliderWithID;

    await strudelModule.initStrudel({
      prebake: async () => {
        const drumMachines = strudelModule!.samples(
          "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json",
          undefined,
          { tag: "tidal-drum-machines" },
        );
        const uzuDrumkit = strudelModule!.samples(
          "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json",
          undefined,
          { tag: "uzu-drumkit" },
        );
        await Promise.all([
          strudelModule!.registerSynthSounds(),
          strudelModule!.registerZZFXSounds(),
          // Dynamic import: see module doc above — @strudel/soundfonts reads `window` at
          // import time, which blows up outside a real browser.
          import("@strudel/soundfonts").then(({ registerSoundfonts }) => registerSoundfonts()),
          strudelModule!.samples("github:tidalcycles/dirt-samples", undefined, {
            tag: "dirt-samples",
          }),
          strudelModule!.samples(
            "https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json",
            undefined,
            { tag: "piano" },
          ),
          strudelModule!.samples(
            "https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json",
            undefined,
            { tag: "vcsl" },
          ),
          strudelModule!.samples(
            "https://raw.githubusercontent.com/felixroos/dough-samples/main/mridangam.json",
            undefined,
            { tag: "mridangam" },
          ),
          strudelModule!.samples(
            "https://raw.githubusercontent.com/tidalcycles/uzu-wavetables/main/strudel.json",
            undefined,
            { tag: "uzu-wavetables" },
          ),
          drumMachines,
          uzuDrumkit,
        ]);
        // aliasBank() only aliases sounds already registered at call time (see module
        // doc above) — the Promise.all above already guarantees drumMachines/uzuDrumkit
        // resolved before this runs.
        await strudelModule!.aliasBank(
          "https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json",
        );
      },
    });

    // @strudel/web's own unlock path (a `mousedown` listener that's supposed to call
    // .resume() on first gesture) has a bug that makes it a no-op, and only listens for
    // "mousedown" rather than "touchstart"/"click" anyway. Desktop Chrome/Firefox mask
    // this because a context created directly inside a real click handler often comes up
    // already "running" — but iOS Safari is strict and needs an explicit .resume() call
    // within the gesture, or audio silently never starts. getStrudel() itself is always
    // invoked from a click handler (see module doc above), so this call is still inside
    // the user gesture and safe to call synchronously-ish here.
    await resumeAudioContext();

    // iOS Safari also suspends the AudioContext when the tab is backgrounded, the screen
    // locks, or a phone call interrupts — without this it stays "suspended" (silently) on
    // return, since nothing else in the app re-resumes it. This only re-arms the context
    // that already exists; it still needs to have been unlocked by a gesture first.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeAudioContext();
    });
  }
  return strudelModule;
}

async function resumeAudioContext() {
  try {
    const ctx = strudelModule?.getAudioContext();
    if (ctx && ctx.state !== "running") await ctx.resume();
  } catch {
    // Nothing useful to do if resume() itself rejects (e.g. context already closed) —
    // playback will just fail loudly elsewhere if audio truly isn't available.
  }
}

/**
 * Non-initializing check: returns the module if getStrudel() has already succeeded
 * elsewhere (from a real user gesture), or null otherwise. For things that want to hook
 * into the audio graph passively (LiveWaveform) without themselves being the thing that
 * triggers @strudel/web's eager init — that should only ever happen from an explicit
 * evaluate/hush click, not a background effect on mount.
 */
export function getStrudelIfReady() {
  return strudelModule;
}

/**
 * Resolves a registered sound name (as it appears in the bank/instruments lists) to its
 * decoded AudioBuffer — reusing superdough's own bank-index resolution and its URL decode
 * cache (getSampleInfo/loadBuffer, re-exported straight through from the `superdough`
 * package via @strudel/web), so this never re-fetches or re-decodes anything already
 * loaded to play. Returns null for synths/wavetables (nothing sample-based to decode) or
 * an unrecognized name — callers (loop-seam analysis, previews) treat that as "not
 * applicable" rather than an error.
 */
export async function getSampleBufferForName(name: string, n = 0): Promise<AudioBuffer | null> {
  const strudel = await getStrudel();
  const entry = strudel.getSound(name);
  const bank = entry?.data?.samples;
  if (!bank) return null;
  const { url } = strudel.getSampleInfo({ s: name, n }, bank);
  if (!url) return null;
  return strudel.loadBuffer(url, strudel.getAudioContext(), name, n);
}
