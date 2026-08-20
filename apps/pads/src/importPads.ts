// Best-effort reverse transform for pads: turns Strudel source text back into a pad->ref
// assignment array, the inverse of chain.ts's buildRackCode/buildRecordingCode. Recognizes
// this app's own two output shapes plus a couple of common hand-written supersets; anything
// else (a richer pattern, an effects chain, a non-mini-notation source) can't be represented
// on a 64-pad grid at all and is reported via `unmatchedRanges` instead of guessed at or
// silently dropped — see PAD_COUNT below for what happens when a matched pattern has more
// refs than there are pads.
import { PAD_COUNT } from "./components/PadGrid";

export interface CodeRange {
  start: number;
  end: number;
}

export interface ParsedPads {
  names: (string | null)[];
  unmatchedRanges: CodeRange[];
  /** How many recognized refs past PAD_COUNT had to be dropped — surfaced so the caller can
   * say so, rather than silently truncating (see the "no silent caps" convention this
   * codebase already follows elsewhere, e.g. patch.ts's unterminatedSourceIds). */
  droppedRefCount: number;
}

const SETCPS_PATTERN = /^\s*setcps\([^)]*\)\s*/;

function skipString(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === quote) return j;
    j++;
  }
  return j;
}

function findMatchingClose(s: string, openIndex: number): number {
  const stack: string[] = [];
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") stack.push(ch);
    else if (ch === ")" || ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string, start: number, end: number, sep: string): CodeRange[] {
  const parts: CodeRange[] = [];
  const stack: string[] = [];
  let partStart = start;
  for (let i = start; i < end; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") stack.push(ch);
    else if (ch === ")" || ch === "}" || ch === "]") stack.pop();
    else if (ch === sep && stack.length === 0) {
      parts.push({ start: partStart, end: i });
      partStart = i + 1;
    }
  }
  parts.push({ start: partStart, end });
  return parts;
}

function trimRange(s: string, start: number, end: number): CodeRange {
  while (start < end && /\s/.test(s[start])) start++;
  while (end > start && /\s/.test(s[end - 1])) end--;
  return { start, end };
}

/** One `s("<...>")` or `s("...").slow(n)` branch's own refs — mini-notation tokens split on
 * whitespace, `~` a rest (a `null` pad), a `[a,b]` chord token collapsed to its first ref
 * (a pad is a single ref; see buildRecordingCode's own doc comment on why a chord even
 * shows up here at all). Returns null if the branch isn't that shape at all. */
function parseSPatternBranch(code: string, start: number, end: number): (string | null)[] | null {
  const m = /^s\(\s*(['"])([\s\S]*?)\1\s*\)(?:\.slow\([^)]*\))?\s*$/.exec(code.slice(start, end));
  if (!m) return null;
  let inner = m[2].trim();
  // buildRackCode's own `<...>` mini-notation wrapper — one ref per cycle. Stripping it is
  // safe here: whether the string was wrapped in `<>` or not, splitting on whitespace reads
  // the same sequence of tokens either way for this app's own purposes (a pad grid has no
  // "per-cycle" concept of its own).
  if (inner.startsWith("<") && inner.endsWith(">")) inner = inner.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(/\s+/).map((tok) => {
    if (tok === "~") return null;
    const chord = /^\[(.+)\]$/.exec(tok);
    if (chord) return chord[1].split(",")[0]?.trim() || null;
    return tok;
  });
}

export function parsePadCode(code: string): ParsedPads {
  const withoutCps = code.replace(SETCPS_PATTERN, "");
  const cpsOffset = code.length - withoutCps.length;
  const trimmed = trimRange(withoutCps, 0, withoutCps.length);
  const wholeText = withoutCps.slice(trimmed.start, trimmed.end);

  const branchRanges: CodeRange[] = /^stack\(/.test(wholeText)
    ? (() => {
        const openIdx = trimmed.start + "stack(".length - 1;
        const closeIdx = findMatchingClose(withoutCps, openIdx);
        if (closeIdx === -1) return [trimmed];
        return splitTopLevel(withoutCps, openIdx + 1, closeIdx, ",");
      })()
    : [trimmed];

  const names: (string | null)[] = [];
  const unmatchedRanges: CodeRange[] = [];
  let droppedRefCount = 0;

  for (const range of branchRanges) {
    const r = trimRange(withoutCps, range.start, range.end);
    if (r.start >= r.end) continue;
    if (withoutCps.slice(r.start, r.end) === "silence") continue;
    const refs = parseSPatternBranch(withoutCps, r.start, r.end);
    if (!refs) {
      unmatchedRanges.push({ start: r.start + cpsOffset, end: r.end + cpsOffset });
      continue;
    }
    for (const ref of refs) {
      if (names.length < PAD_COUNT) names.push(ref);
      else if (ref !== null) droppedRefCount++;
    }
  }

  while (names.length < PAD_COUNT) names.push(null);
  return { names, unmatchedRanges, droppedRefCount };
}
