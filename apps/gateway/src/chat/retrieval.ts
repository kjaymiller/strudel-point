// Retrieval over the generated Strudel index (strudelApi.json), for putting the relevant
// slice of Strudel's documentation *into* the prompt rather than making the model ask for
// it a function at a time.
//
// Why this replaced the lookup tools: every question the model had to ask cost a round
// trip, and a turn is bounded by MAX_ITERATIONS. Watching a local 9B model spend six of its
// ten iterations on lookup_function and search_docs — correctly, it was doing exactly what
// it was told — and then run out before it could answer made the shape of the problem
// obvious. The answers were always going to come from a 1,000-entry index sitting in
// memory; asking for them one at a time was the expensive way to read a local file.
//
// So: score the whole index against the request before the first model call, and hand over
// the top slice. Retrieval is cheap (a few milliseconds over ~1,000 documents), it happens
// once, and it costs no iterations at all.

import {
  type StrudelFunction,
  FREE_NAMES,
  lookup,
  METHOD_NAMES,
  STRUDEL_VERSIONS,
  functions as ALL,
} from "./strudelApi.js";

/**
 * Words carrying no signal about which function someone wants. Deliberately generic
 * English only — no Strudel vocabulary, because deciding that "pattern" or "sound" is
 * uninformative is exactly the kind of hand-tuning that made the old allowlist wrong.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could do does for from get give go had has have how i if in into is it its " +
    "just like make me my need not of on once one only or please put should so some that the their them then there " +
    "these they this to too up us use want was we what when where which who will with would you your"
  ).split(" "),
);

/**
 * Crude suffix stripping, applied identically to the index and the query so the two always
 * agree. Without it "make it faster" misses `fast` and "reversing" misses `rev` — the words
 * people ask with are inflected, and the documentation is not.
 */
function stem(token: string): string {
  for (const suffix of ["ings", "ing", "ies", "ed", "es", "er", "ly", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/** Documents, one per unique name, with their searchable text pre-tokenised. */
interface Indexed {
  name: string;
  entries: StrudelFunction[];
  nameTokens: Set<string>;
  bodyTerms: Map<string, number>;
  /** Total weighted terms, for length normalisation. */
  length: number;
}

const documents: Indexed[] = [];
const documentFrequency = new Map<string, number>();

{
  const grouped = new Map<string, StrudelFunction[]>();
  for (const fn of ALL) {
    const list = grouped.get(fn.name);
    if (list) list.push(fn);
    else grouped.set(fn.name, [fn]);
  }

  for (const [name, entries] of grouped) {
    const bodyTerms = new Map<string, number>();
    for (const entry of entries) {
      // Descriptions carry the meaning; examples carry the vocabulary someone actually
      // types (`bd`, `c3:minor`), which is often how a request is phrased.
      for (const token of tokenize(`${entry.description ?? ""} ${(entry.synonyms ?? []).join(" ")}`)) {
        bodyTerms.set(token, (bodyTerms.get(token) ?? 0) + 2);
      }
      for (const token of tokenize((entry.examples ?? []).join(" "))) {
        bodyTerms.set(token, (bodyTerms.get(token) ?? 0) + 1);
      }
    }
    // camelCase and snake_case names are split so "fast gap" finds fastGap.
    const nameTokens = new Set([
      name.toLowerCase(),
      stem(name.toLowerCase()),
      ...tokenize(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")),
    ]);

    let length = 0;
    for (const weight of bodyTerms.values()) length += weight;
    documents.push({ name, entries, nameTokens, bodyTerms, length: Math.max(1, length) });
    for (const term of new Set([...bodyTerms.keys(), ...nameTokens])) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
}

/**
 * The functions Strudel's own examples reach for most often — `s`, `n`, `note`, `stack` and
 * so on. They are always included, because no request ever names them: "give me a kick with
 * a hat on the offbeat" needs `s` and `stack` and mentions neither, and a model left to
 * recall the foundations while being handed documentation for the details gets the
 * foundations wrong.
 *
 * Derived by counting name occurrences across every example in the index rather than
 * written down. The documentation already knows which functions are fundamental — a list
 * typed out here would be one more thing to be wrong about after an upgrade, which is the
 * mistake the generated index exists to stop repeating.
 */
const CORE_COUNT = 6;

const coreNames: string[] = (() => {
  const uses = new Map<string, number>();
  for (const fn of ALL) {
    for (const example of fn.examples ?? []) {
      for (const match of example.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = match[1];
        if (FREE_NAMES.has(name)) uses.set(name, (uses.get(name) ?? 0) + 1);
      }
    }
  }
  return [...uses.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CORE_COUNT)
    .map(([name]) => name);
})();

/** Exposed for the tests, which assert this stayed sane across a Strudel upgrade. */
export const CORE_FUNCTIONS: readonly string[] = coreNames;

/**
 * Inverse document frequency. Without it, a common word like "pattern" — which appears in
 * hundreds of descriptions — outweighs the one rare word in the request that actually
 * identifies what someone wants.
 */
function idf(term: string): number {
  return Math.log(documents.length / (1 + (documentFrequency.get(term) ?? 0)));
}

/** Identifiers already in the room's buffer: whatever is being edited is relevant by definition. */
function identifiersIn(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/[.\b]?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (FREE_NAMES.has(name) || METHOD_NAMES.has(name)) found.add(name);
  }
  return [...found];
}

export interface RetrievalResult {
  /** Ready to append to the system prompt. Empty when nothing scored. */
  context: string;
  /** Which functions were included, in rank order — for logging and tests. */
  names: string[];
}

const DEFAULT_LIMIT = 14;
/**
 * Character ceiling on the injected block. A local 9B model reading 40kB of reference
 * before the request itself is a worse outcome than a shorter, sharper slice — and the
 * request is what it is supposed to be answering.
 */
const DEFAULT_BUDGET = 5000;

export function retrieveDocs({
  query,
  code = "",
  limit = DEFAULT_LIMIT,
  budget = DEFAULT_BUDGET,
}: {
  query: string;
  /** The room's current buffer, if any. */
  code?: string;
  limit?: number;
  budget?: number;
}): RetrievalResult {
  const terms = tokenize(query);
  const scored: Array<{ doc: Indexed; score: number }> = [];

  if (terms.length > 0) {
    for (const doc of documents) {
      let score = 0;
      for (const term of terms) {
        const weight = idf(term);
        // An exact name in the request is as strong a signal as retrieval gets: someone
        // writing "does .ply exist" wants .ply, whatever the rest of the sentence says.
        // Name bonuses are scaled by how informative the word is. Flat bonuses let a word
        // like "pattern" — which is in this domain's every other sentence, and in the names
        // Pattern, isPattern, patternifyAST — outrank the rare word that says what the
        // request is actually about. An exact name still wins outright, because someone who
        // types a function's name means that function.
        const informative = Math.min(1, Math.max(0, weight) / 2);
        // Even an exact name match is scaled, with a floor: `Pattern` is a real export and
        // "pattern" is also the most common word in any request about patterns, so an
        // unscaled exact match makes the base class the top hit for half the questions asked.
        // Rare names keep the full bonus — "does ply exist" still puts `ply` first.
        if (doc.name.toLowerCase() === term) score += 20 * Math.max(0.15, informative);
        else if (doc.nameTokens.has(term)) score += 10 * informative;
        else if (doc.name.toLowerCase().includes(term) && term.length >= 4) score += 4 * informative;
        // Strudel abbreviates: `rev` for reverse, `seg` for segment, `hpf` for highpass.
        // Stemming can't bridge that — "reverse" stems to "revers", which matches neither
        // `rev` nor `reverse` — so a name that prefixes the asked-for word counts too.
        else if (doc.name.length >= 3 && term.startsWith(doc.name.toLowerCase())) score += 8 * informative;
        const body = doc.bodyTerms.get(term);
        if (body) {
          // Log-damped and length-normalised, i.e. ordinary TF-IDF. Raw term counts rank a
          // parameter that says "reverb" four times above the reverb function itself:
          // `roomlp`, `roomdim` and `roomfade` all describe *how* the reverb behaves and so
          // repeat the word, while `room` — the one anybody asking for reverb wants — says
          // it once. Normalising by document length puts the short, central entry back on top.
          score += Math.max(0.2, weight) * ((1 + Math.log(body)) / Math.sqrt(doc.length));
        }
      }
      if (score <= 0) continue;
      // Undocumented names are real functions but mostly Strudel's internals — patternifyAST,
      // filterHaps, isPattern. They match on name fragments and would otherwise crowd out the
      // documented functions someone asking a question actually wants. Demoted rather than
      // dropped: an undocumented name is still better than an invented one.
      const documented = doc.entries.some((entry) => entry.description);
      const demonstrated = doc.entries.some((entry) => entry.examples?.length);
      scored.push({ doc, score: score * (documented ? 1 : 0.3) * (demonstrated ? 1.3 : 1) });
    }
    scored.sort((a, b) => b.score - a.score || a.doc.name.length - b.doc.name.length);
  }

  const byNameIndex = new Map(documents.map((doc) => [doc.name, doc]));

  // Always present, whatever was asked:
  //   - what the room is already playing. Editing a pattern without the docs for the
  //     functions it already uses is how "make it faster" becomes an accidental rewrite.
  //   - the foundations, which no request ever names (see coreNames).
  const reserved: Indexed[] = [];
  const takenReserved = new Set<string>();
  for (const name of [...identifiersIn(code), ...coreNames]) {
    const doc = byNameIndex.get(name);
    if (doc && !takenReserved.has(name)) {
      takenReserved.add(name);
      reserved.push(doc);
    }
  }
  reserved.splice(limit);

  // Query hits lead, in rank order. The first entries are the ones a small model weighs
  // most, so the best answer to what was actually asked has to be at the top — burying it
  // under six foundational entries is how "does ply exist" gets answered with `s`.
  const chosen: Indexed[] = [];
  for (const { doc } of scored) {
    if (chosen.length >= limit - reserved.length) break;
    if (takenReserved.has(doc.name)) continue;
    chosen.push(doc);
  }
  chosen.push(...reserved);

  if (chosen.length === 0) return { context: "", names: [] };

  const version = STRUDEL_VERSIONS["@strudel/core"] ?? "";
  const header =
    `Strudel ${version} reference — the entries below were selected for this request and are ` +
    "the real API, copied from Strudel's own documentation. Prefer them over recollection. " +
    "This is a slice, not the whole language: a function not listed here may still exist, but " +
    "one you cannot name from these or from the buffer is a guess, and a guess that parses " +
    "will throw for everyone in the room.\n";

  const blocks: string[] = [];
  let used = header.length;
  const included: string[] = [];

  for (const doc of chosen) {
    const entry = doc.entries.find((e) => e.description) ?? doc.entries[0];
    const forms = doc.entries
      .map((e) => (e.kind === "method" ? `.${e.name}(...)` : `${e.name}(...)`))
      .join(" / ");
    // The argument count is part of the signature and the only one Strudel enforces —
    // `.every(2)` is a real function, correctly spelled, that throws on evaluate.
    const arity = doc.entries.find((e) => e.requiredArgs !== undefined)?.requiredArgs;
    const takes =
      arity === undefined ? "" : `  [takes exactly ${arity} ${arity === 1 ? "argument" : "arguments"}]`;
    let block = `\n${forms}${takes}`;
    if (entry.description) block += `\n  ${entry.description}`;
    if (entry.synonyms?.length) block += `\n  also: ${entry.synonyms.join(", ")}`;
    const example = entry.examples?.[0];
    if (example) block += `\n  e.g. ${example.replace(/\n+/g, " ")}`;

    // +1 for the newline join between blocks — without it the assembled string can land
    // just over a budget every individual check said it was under.
    if (used + block.length + 1 > budget) continue;
    used += block.length + 1;
    blocks.push(block);
    included.push(doc.name);
  }

  return { context: blocks.length > 0 ? header + blocks.join("\n") : "", names: included };
}

/** Re-exported so callers don't need a second import to check a name. */
export { lookup };
