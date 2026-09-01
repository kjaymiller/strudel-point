import { describe, expect, it } from "vitest";
import {
  describe as describeFn,
  FREE_NAMES,
  lookup,
  METHOD_NAMES,
  search,
  STRUDEL_VERSIONS,
  suggest,
} from "./strudelApi.js";

// strudelApi.json is generated (scripts/build-strudel-api.ts), so these tests are really
// about the *generator*: after a @strudel upgrade, a parser that silently stopped matching
// would leave the bot with a shrunken vocabulary and no error anywhere. A thin index is the
// failure mode to catch, because its symptom is the bot being told correct code is wrong.
describe("the generated Strudel API index", () => {
  it("covers the whole API, not a handful of names", () => {
    expect(FREE_NAMES.size).toBeGreaterThan(500);
    expect(METHOD_NAMES.size).toBeGreaterThan(100);
  });

  it("records which Strudel it was generated from", () => {
    expect(STRUDEL_VERSIONS["@strudel/core"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has the everyday vocabulary a pattern can't be written without", () => {
    for (const name of ["s", "n", "note", "sound", "stack", "cat", "seq", "silence", "scale"]) {
      expect(FREE_NAMES.has(name)).toBe(true);
    }
    // REPL-injected: these live in no package source, so the generator adds them by hand.
    // Without them the validator rejects the tempo line of almost every pattern.
    for (const name of ["setcpm", "setcps", "samples", "hush"]) {
      expect(FREE_NAMES.has(name)).toBe(true);
    }
  });

  it("has the chain vocabulary, which register() generates and no static parse would see", () => {
    for (const name of ["gain", "fast", "slow", "every", "room", "lpf", "jux", "off", "ply"]) {
      expect(FREE_NAMES.has(name) || METHOD_NAMES.has(name)).toBe(true);
    }
  });

  it("carries descriptions and runnable examples, not just names", () => {
    const [jux] = lookup("jux");
    expect(jux.description).toMatch(/stereo/i);
    expect(jux.examples?.[0]).toContain("jux");
    // Examples are lifted from Strudel's own docs, so they have to be real code.
    for (const example of jux.examples ?? []) expect(() => new Function(example)).not.toThrow();
  });

  it("knows a name it doesn't have", () => {
    expect(lookup("definitelyNotAStrudelFunction")).toEqual([]);
  });

  it("finds functions by what they do, which is how someone asks", () => {
    expect(search("reverb").map((fn) => fn.name)).toContain("room");
    expect(search("random").map((fn) => fn.name).length).toBeGreaterThan(0);
    expect(search("reverse").map((fn) => fn.name)).toContain("rev");
  });

  it("returns nothing rather than noise for a query that matches nothing", () => {
    expect(search("qqqzzzxxx")).toEqual([]);
  });

  it("suggests a near miss but invents nothing for a name with no neighbours", () => {
    expect(suggest("gian")).toContain("gain");
    expect(suggest("setCPM")).toContain("setcpm");
    expect(suggest("reverb")).toEqual([]);
  });

  it("renders free and chained calls differently, because that's the mistake being prevented", () => {
    const [free] = lookup("stack");
    expect(describeFn(free)).toMatch(/^stack\(\.\.\.\)/);
    const chained = lookup("gain").find((fn) => fn.kind === "method");
    if (chained) expect(describeFn(chained)).toMatch(/^\.gain\(\.\.\.\)/);
  });
});
