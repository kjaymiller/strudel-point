// Generates apps/gateway/src/chat/strudelVocabulary.json — the *non-function* half of what
// the bot needs to write Strudel: mini-notation syntax, the sample names that actually
// resolve, and the scale names .scale() accepts.
//
// strudelApi.json covers functions. It cannot cover any of this: `~`, `*4`, `[a b]`,
// `<a b>` and `(3,8)` are a parser, not an API, and sample and scale names are data fetched
// at runtime. That gap is where every failure from a small model has actually landed —
// `4` used as a rest, `s("4*4")` as a drum pattern — while the function index it *did* have
// was never the thing it got wrong.
//
// Same principle as the API index: derive, don't type it out. The hand-written drum list in
// the system prompt named `oh` and `rim`, and neither is in dirt-samples — so the prompt was
// telling the model to use sounds that silently don't play, which is exactly the failure it
// was written to prevent.
//
// Regenerate:  bun run build:strudel-vocab

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ScaleType } from "@tonaljs/tonal";
import * as krill from "@strudel/mini/krill-parser.js";

const OUT = resolve("apps/gateway/src/chat/strudelVocabulary.json");

// The same manifests apps/web/src/strudel.ts prebakes, so the names here are exactly the
// names that resolve in the browser this bot is writing for. Pinned URLs, not a guess at
// what Strudel ships: if the app's prebake changes, this list has to be regenerated with it.
const MANIFESTS: Array<{ tag: string; url: string; kind: "sample" | "bank" }> = [
  { tag: "dirt-samples", url: "https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/strudel.json", kind: "sample" },
  { tag: "uzu-drumkit", url: "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json", kind: "sample" },
  { tag: "tidal-drum-machines", url: "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json", kind: "bank" },
];

/** Registered without a fetch by registerSynthSounds/registerZZFXSounds — see strudel.ts. */
const SYNTHS = ["sine", "square", "triangle", "sawtooth", "saw", "pulse", "supersaw", "white", "pink", "brown", "crackle", "zzfx"];

/**
 * Mini-notation, which is a grammar rather than a set of functions and so appears nowhere
 * in strudelApi.json. Every example below is parsed with Strudel's own krill parser at
 * build time — the build fails rather than shipping a syntax hint that is itself wrong.
 */
const MINI_NOTATION: Array<{ syntax: string; means: string; example: string }> = [
  { syntax: "~", means: "a rest — silence for one step. This is the ONLY rest; a number like 4 is a sound name, not a gap.", example: "bd ~ sd ~" },
  { syntax: "a b c", means: "a sequence: the step divides the cycle evenly between them", example: "bd sd hh" },
  { syntax: "*n", means: "repeat n times inside the same step (faster)", example: "bd*4" },
  { syntax: "/n", means: "stretch across n cycles (slower)", example: "bd/2" },
  { syntax: "[a b]", means: "group — one step containing a subsequence", example: "bd [sd sd] hh" },
  { syntax: "<a b>", means: "alternate — a on the first cycle, b on the next", example: "<bd sd> hh" },
  { syntax: "a,b", means: "play together (a chord, or layered parts)", example: "bd*4, hh*8" },
  { syntax: "a(k,n)", means: "euclidean rhythm: k hits spread over n steps", example: "bd(3,8)" },
  { syntax: "a@n", means: "give a step n times the usual length", example: "bd@3 sd" },
  { syntax: "a!n", means: "repeat a as n separate steps", example: "bd!3 sd" },
  { syntax: "a?", means: "play it randomly, about half the time", example: "bd*8?" },
  { syntax: "a:n", means: "pick sample number n from that name's folder", example: "bd:3 sd:2" },
  { syntax: "a .. b", means: "a numeric range, expanded", example: "0 .. 7" },
];

async function fetchNames(url: string): Promise<string[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as Record<string, unknown>;
  return Object.keys(body).filter((key) => !key.startsWith("_"));
}

// ── mini-notation, verified against the real parser ──────────────────────────────────

for (const entry of MINI_NOTATION) {
  try {
    // krill takes a *quoted* mini string — the quotes are part of its input grammar.
    (krill as { parse(input: string): unknown }).parse(JSON.stringify(entry.example));
  } catch (err) {
    throw new Error(
      `mini-notation example ${JSON.stringify(entry.example)} for "${entry.syntax}" does not parse: ` +
        `${err instanceof Error ? err.message : err}. Fix the example — shipping a syntax hint that ` +
        "is itself wrong is worse than shipping none.",
    );
  }
}

// ── samples and banks ────────────────────────────────────────────────────────────────

const samples = new Set<string>(SYNTHS);
const banks = new Set<string>();
let networkOk = true;

for (const manifest of MANIFESTS) {
  try {
    const names = await fetchNames(manifest.url);
    if (manifest.kind === "sample") for (const name of names) samples.add(name);
    else {
      // Drum-machine packs key on `${Bank}_${sound}`; the bank is what .bank() takes.
      for (const name of names) {
        const [bank] = name.split("_");
        if (bank) banks.add(bank);
      }
    }
    console.log(`  ${manifest.tag}: ${names.length} entries`);
  } catch (err) {
    networkOk = false;
    console.warn(`  ! ${manifest.tag} unreachable (${err instanceof Error ? err.message : err})`);
  }
}

// A build with no network must not quietly ship an empty vocabulary — that would take the
// bot from "knows 218 sample names" to "knows none" with nothing failing. Keep what's
// already generated instead, and say so.
if (!networkOk && existsSync(OUT)) {
  const previous = JSON.parse(readFileSync(OUT, "utf8")) as { samples?: string[]; banks?: string[] };
  for (const name of previous.samples ?? []) samples.add(name);
  for (const name of previous.banks ?? []) banks.add(name);
  console.warn("  ! kept the previously generated sample list for the manifests that failed");
}

const scales = ScaleType.all()
  .map((scale) => scale.name)
  .filter(Boolean)
  .sort();

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      miniNotation: MINI_NOTATION,
      samples: [...samples].sort(),
      banks: [...banks].sort(),
      scales,
    },
    null,
    1,
  )}\n`,
);

console.log(
  `wrote ${OUT}\n  ${MINI_NOTATION.length} mini-notation forms (all parsed), ${samples.size} sample names, ` +
    `${banks.size} banks, ${scales.length} scales`,
);
