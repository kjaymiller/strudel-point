// Shared @strudel/web singleton for the dj app — same shape as apps/web/src/strudel.ts
// (a separate copy, not an import, since the two apps are deliberately independent
// deployables that just happen to talk to the same gateway/room). See that file for the
// long-form rationale on prebake/aliasBank ordering and the iOS resume() dance; unchanged
// here because decks need exactly the same sample packs (dirt-samples + tidal drum
// machines) available to resolve whatever bank names a room's custom samples used. This
// app deliberately doesn't fetch/register a room's *custom* samples itself — see
// App.tsx's handleEvent comment: sample/bank management belongs to apps/pads now — so
// listRegisteredSounds below only ever reflects these built-in packs, not any custom
// upload, for @strudel-point/library's <LibraryDrawer> "all sounds" tab.
import type { RegisteredSound } from "@strudel-point/library";

let strudelModule: typeof import("@strudel/web") | null = null;
let repl: import("@strudel/web").StrudelRepl | null = null;

export async function getStrudel() {
  if (!strudelModule) {
    strudelModule = await import("@strudel/web");

    // initStrudel() resolves to the underlying repl object (scheduler, evaluate,
    // setCps, ...), not void — captured here because of setCps() below.
    repl = await strudelModule.initStrudel({
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
 * Sets the transport's tempo directly on the repl, rather than by embedding a bare
 * `setcps(...)` call in evaluated code text — confirmed (by testing directly in the
 * browser) that this @strudel/web version doesn't actually wire `setcps`/`setCps` up as
 * a callable name inside evaluated code: `window.setcps` stays `undefined` even after a
 * real evaluate() call, and even shimming `globalThis.setcps` doesn't help — evaluated
 * code apparently doesn't resolve names against `globalThis` the way `s`/`stack`/`hush`
 * (which *are* real globals) do, so whatever scope it does use isn't one this app can
 * reach from outside. That's the actual cause behind "starting and stopping isn't
 * working": it's not a play/stop-specific bug, `evaluate()` was failing outright on the
 * very first line, every time, since every pattern this app generates or saves leads
 * with `setcps(...)`. This function is the confirmed-working path instead: the repl's
 * own `setCps(cps)` method really does change the running tempo. Call this *before*
 * evaluate()ing code whose text has had its own leading `setcps(...)` stripped (see
 * chain.ts's splitTrackCode) — evaluating a string that still contains a bare
 * `setcps(...)` call will still throw, this doesn't patch that.
 */
export function setCps(cps: number) {
  repl?.setCps(cps);
}

/**
 * Non-initializing check: returns the module if getStrudel() has already succeeded
 * elsewhere (from a real user gesture), or null otherwise — same contract as
 * apps/web/src/strudel.ts's version.
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

/** Reads the live sound registry — feeds @strudel-point/library's <LibraryDrawer>. */
export async function listRegisteredSounds(): Promise<RegisteredSound[]> {
  const strudel = await getStrudel();
  const registry = strudel.soundMap.get();
  return Object.entries(registry)
    .map(([name, entry]) => ({ name, type: entry.data?.tag ?? entry.data?.type ?? "sound" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
