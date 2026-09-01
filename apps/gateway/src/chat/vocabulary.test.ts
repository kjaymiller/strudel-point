import { describe, expect, it } from "vitest";
import * as krill from "@strudel/mini/krill-parser.js";
import { BANKS, MINI_NOTATION, SAMPLES, SCALES, vocabularyBlock } from "./vocabulary.js";

describe("the generated vocabulary", () => {
  it("has the sample names the bot is told to use", () => {
    for (const name of ["bd", "sd", "hh", "oh", "cp", "rim", "lt", "mt", "ht"]) {
      expect(SAMPLES).toContain(name);
    }
    expect(SAMPLES.length).toBeGreaterThan(200);
  });

  it("has the scales and banks the chain methods take", () => {
    for (const scale of ["major", "minor", "dorian", "major pentatonic", "harmonic minor"]) {
      expect(SCALES).toContain(scale);
    }
    expect(BANKS).toContain("RolandTR909");
  });

  // The point of a syntax hint is that it is right. Every example ships pre-verified by the
  // generator, and this re-checks it against the same parser the browser uses — a wrong hint
  // is worse than no hint, because the model has no way to tell.
  it("only claims mini-notation that Strudel's own parser accepts", () => {
    expect(MINI_NOTATION.length).toBeGreaterThan(8);
    for (const form of MINI_NOTATION) {
      expect(() =>
        (krill as { parse(input: string): unknown }).parse(JSON.stringify(form.example)),
      ).not.toThrow();
    }
  });

  it("always carries mini-notation and sample names, whatever was asked", () => {
    const block = vocabularyBlock({ query: "add a hat" });
    expect(block).toContain("Mini-notation");
    expect(block).toContain("bd");
    expect(block).toMatch(/~/);
  });

  // 90 scale names and 71 bank names are worth their space to a melodic request and are
  // attention a small model needs elsewhere when the ask is "add a hi-hat".
  it("leaves out the long lists that a request has no use for", () => {
    const drums = vocabularyBlock({ query: "give me a kick and a hat" });
    expect(drums).not.toContain("phrygian");
    expect(drums).not.toContain("RolandTR909");

    const melodic = vocabularyBlock({ query: "write a minor melody" });
    expect(melodic).toContain("phrygian");

    const banked = vocabularyBlock({ query: "use a 909 bank" });
    expect(banked).toContain("RolandTR909");
  });

  it("takes the buffer into account, not just the words typed", () => {
    const block = vocabularyBlock({ query: "make it better", code: 'n("0 2 4").scale("c3:minor")' });
    expect(block).toContain("phrygian");
  });
});
