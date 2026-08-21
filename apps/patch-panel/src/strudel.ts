// Shared @strudel/web singleton for the patch-panel app — same shape as
// apps/pads/src/strudel.ts (a separate copy, not an import, since these are deliberately
// independent deployables that just happen to talk to the same gateway/room). The synth
// panel itself never needs the sample packs pads/dj prebake for its own VCO/etc. modules
// (they play oscillator waveforms via superdough's built-in synths directly), but a
// Sampler module can point at any registered sound — including a GM instrument, once
// registerSoundfonts below runs — and "eval"-ing a saved patch+sequence that references
// a room sample bank by name needs this room's own custom uploads registered too, on top
// of the same built-in packs pads/dj prebake for parity (see
// registerAllSamples/listRegisteredSounds below, and App.tsx's useChannelLibrary
// wiring). The synth/zzfx/soundfont registrations are in-memory only, so there's no
// reason this app's <LibraryDrawer> "all sounds" tab should show a narrower set than
// apps/web's own SoundBank does.

import { bankSampleUrls, groupSampleBanks, type RegisteredSound } from "@strudel-point/library";
import type { CustomSample } from "@strudel-point/shared";

let strudelModule: typeof import("@strudel/web") | null = null;

export async function getStrudel() {
  if (!strudelModule) {
    strudelModule = await import("@strudel/web");

    await strudelModule.initStrudel({
      prebake: async () => {
        await Promise.all([
          strudelModule!.samples("github:tidalcycles/dirt-samples", undefined, {
            tag: "dirt-samples",
          }),
          strudelModule!.samples(
            "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json",
            undefined,
            { tag: "tidal-drum-machines" },
          ),
          strudelModule!.registerSynthSounds(),
          strudelModule!.registerZZFXSounds(),
          // Dynamic import: see apps/web/src/strudel.ts — @strudel/soundfonts reads
          // `window` at import time, which blows up outside a real browser.
          import("@strudel/soundfonts").then(({ registerSoundfonts }) => registerSoundfonts()),
        ]);
        await strudelModule!.aliasBank(
          "https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json",
        );
      },
    });

    await resumeAudioContext();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeAudioContext();
    });
  }
  return strudelModule;
}

/**
 * Non-initializing check: returns the module if getStrudel() has already succeeded
 * elsewhere (from a real user gesture), or null otherwise — same contract as
 * apps/pads/src/strudel.ts's version.
 */
export function getStrudelIfReady() {
  return strudelModule;
}

async function resumeAudioContext() {
  try {
    const ctx = strudelModule?.getAudioContext();
    if (ctx && ctx.state !== "running") await ctx.resume();
  } catch {
    // see apps/web/src/strudel.ts — nothing useful to do if resume() itself rejects
  }
}

/**
 * Registers every custom sample this channel has for playback — grouped by bank first
 * (see @strudel-point/library's groupSampleBanks), same rule apps/web/apps/pads each
 * independently reimplemented. Recomputed from the full current list each time, so it's
 * idempotent and self-corrects regardless of the order bank slices arrive in (relevant
 * for peers receiving a `sample:added` event one slice at a time).
 */
export async function registerAllSamples(samples: CustomSample[]) {
  const strudel = await getStrudel();
  const { banks, singles } = groupSampleBanks(samples);
  await Promise.all([
    ...singles.map((s) => strudel.samples({ [s.name]: s.url })),
    ...banks.map((bank) => strudel.samples({ [bank.bankName]: bankSampleUrls(bank) })),
  ]);
}

/** Un-registers a single name — used when a bank gets renamed (the old name has to stop
 * resolving before the new one takes over), same as apps/web's forgetSound. */
export async function forgetSound(oldName: string) {
  const strudel = await getStrudel();
  strudel.soundMap.setKey(oldName, undefined);
  strudel.soundMap.setKey(oldName.toLowerCase(), undefined);
}

/** Reads the live sound registry — accurate to whatever packs + custom samples actually
 * ended up loaded, not a guess (see LibraryTray's `registeredSounds` prop). */
export async function listRegisteredSounds(): Promise<RegisteredSound[]> {
  const strudel = await getStrudel();
  const registry = strudel.soundMap.get();
  return Object.entries(registry)
    .map(([name, entry]) => ({ name, type: entry.data?.tag ?? entry.data?.type ?? "sound" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
