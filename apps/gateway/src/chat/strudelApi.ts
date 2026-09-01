// Lookup over the generated Strudel API index (strudelApi.json, built by
// scripts/build-strudel-api.ts from the installed @strudel packages).
//
// This is the bot's only source of truth about what Strudel can do. Everything else it
// "knows" is pretraining, which is where `wait(2)` came from — and where the *opposite*
// mistake came from too: a hand-written allowlist that omitted real functions like `beat`
// and `loop`, so correct code got warned about until the model rewrote it into something
// worse. A generated index fixes both directions at once.

import raw from "./strudelApi.json" with { type: "json" };

export interface StrudelFunction {
  name: string;
  kind: "free" | "method";
  source: string;
  description?: string;
  synonyms?: string[];
  examples?: string[];
  /** Exact argument count this method requires, when Strudel enforces one. */
  requiredArgs?: number;
  silentWithNoArgs?: boolean;
  functionArgs?: number[];
}

const api = raw as { versions: Record<string, string>; functions: StrudelFunction[] };

export const STRUDEL_VERSIONS = api.versions;

/** Every entry, for callers that do their own scoring (see retrieval.ts). */
export const functions: readonly StrudelFunction[] = api.functions;

/** Callable as `name(...)`. */
export const FREE_NAMES: ReadonlySet<string> = new Set(
  api.functions.filter((fn) => fn.kind === "free").map((fn) => fn.name),
);

/** Callable as `.name(...)` in a chain. Many names are both. */
export const METHOD_NAMES: ReadonlySet<string> = new Set(
  api.functions.filter((fn) => fn.kind === "method").map((fn) => fn.name),
);

const byName = new Map<string, StrudelFunction[]>();
for (const fn of api.functions) {
  const list = byName.get(fn.name);
  if (list) list.push(fn);
  else byName.set(fn.name, [fn]);
}

/**
 * Methods that throw unless called with exactly this many arguments. Measured from
 * Strudel's own error messages by the generator — see probeRequiredArgs.
 */
export const REQUIRED_ARGS: ReadonlyMap<string, number> = new Map(
  api.functions
    .filter((fn) => fn.kind === "method" && fn.requiredArgs !== undefined)
    .map((fn) => [fn.name, fn.requiredArgs as number]),
);

/**
 * Methods that silence the pattern outright when called with no arguments. Strudel raises
 * nothing for these — the result simply queries to zero events.
 */
export const SILENT_WITH_NO_ARGS: ReadonlySet<string> = new Set(
  api.functions.filter((fn) => fn.kind === "method" && fn.silentWithNoArgs).map((fn) => fn.name),
);

/**
 * Argument positions that must hold a function rather than a value, per method. Measured by
 * the generator — `.every(16, 3)` throws `e is not a function` from inside a minified bundle.
 */
export const FUNCTION_ARGS: ReadonlyMap<string, readonly number[]> = new Map(
  api.functions
    .filter((fn) => fn.kind === "method" && fn.functionArgs?.length)
    .map((fn) => [fn.name, fn.functionArgs as number[]]),
);

export function lookup(name: string): StrudelFunction[] {
  return byName.get(name) ?? [];
}

/** Levenshtein, capped — only used to suggest alternatives for a name that isn't there. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Names close enough to `name` to be worth offering. A model that reached for a function
 * that doesn't exist usually wanted one that does, and naming it is the difference between
 * a warning it can act on and one it can only retry against.
 */
export function suggest(name: string, limit = 4): string[] {
  const lower = name.toLowerCase();
  const scored = [...byName.keys()].map((candidate) => {
    const c = candidate.toLowerCase();
    if (c === lower) return { candidate, score: 0 };
    // A candidate *containing* the query beats edit distance: `lpf` -> `lpfattack` is a
    // better offer than anything three edits away. Deliberately not the reverse — letting a
    // short name match because the query contains it makes every query suggest `s` and `n`.
    if (c.length >= 3 && c.includes(lower)) return { candidate, score: 1 };
    // Edit distance only counts when the names start the same letter. Without that, `wait`
    // "suggests" fast, gain and unit — four characters apart in a 1,000-name index is
    // coincidence, not a hint, and offering coincidences teaches the model to ignore the
    // suggestions that are real.
    if (c[0] !== lower[0]) return { candidate, score: 99 };
    return { candidate, score: distance(lower, c) + 1 };
  });

  return (
    scored
      .filter((entry) => entry.score <= 3)
      // Same score: prefer the candidate closest in length to what was typed. `gian` should
      // offer `gain` before `gap`, which sorting by raw length gets backwards.
      .sort(
        (a, b) =>
          a.score - b.score ||
          Math.abs(a.candidate.length - name.length) - Math.abs(b.candidate.length - name.length) ||
          a.candidate.length - b.candidate.length,
      )
      .slice(0, limit)
      .map((entry) => entry.candidate)
  );
}

/** Ranked free-text search over names and descriptions. */
export function search(query: string, limit = 8): StrudelFunction[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return api.functions
    .map((fn) => {
      const name = fn.name.toLowerCase();
      const description = (fn.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 10;
        else if (name.includes(term)) score += 4;
        if (description.includes(term)) score += 2;
      }
      // The bonuses below are tie-breakers among things that already matched — applied
      // unconditionally they give every documented function a positive score, and a query
      // matching nothing comes back with a confident list of unrelated names.
      if (score === 0) return { fn, score: 0 };
      // A documented function is a more useful answer than a bare name that happens to
      // contain the term, so break ties toward the ones that can explain themselves.
      if (fn.description) score += 1;
      if (fn.examples?.length) score += 1;
      return { fn, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.fn.name.length - b.fn.name.length)
    .slice(0, limit)
    .map((entry) => entry.fn);
}

/** One-line rendering for search results and tool output. */
export function describe(fn: StrudelFunction): string {
  const how = fn.kind === "method" ? `.${fn.name}(...)` : `${fn.name}(...)`;
  const summary = fn.description ? ` — ${fn.description}` : " — (no description in the source)";
  return `${how}${summary}`;
}
