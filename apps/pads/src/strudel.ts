// Shared @strudel/web singleton for the pads app — same shape as apps/dj/src/strudel.ts
// (a separate copy, not an import, since these are deliberately independent deployables
// that just happen to talk to the same gateway/room). See apps/web/src/strudel.ts for the
// long-form rationale on prebake/aliasBank ordering and the iOS resume() dance; unchanged
// here because pads need exactly the same sample packs (dirt-samples + tidal drum
// machines) available to resolve whatever bank names a room's custom samples used.
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
 * apps/dj/src/strudel.ts's version.
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
