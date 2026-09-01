// @strudel/mini ships its krill parser as generated PEG.js output with no types. The one
// entry point used here is `parse`, and it takes a *quoted* mini-notation string — the
// quotes are part of its input grammar, not a wrapper (see mini2ast in mini.mjs).
declare module "@strudel/mini/krill-parser.js" {
  export function parse(quotedMiniNotation: string): unknown;
}
