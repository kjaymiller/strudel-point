import { describe, expect, it } from "vitest";
import { CORE_FUNCTIONS, retrieveDocs } from "./retrieval.js";

const namesFor = (query: string, code = "") => retrieveDocs({ query, code }).names;

describe("doc retrieval", () => {
  it("finds the function that does what was asked", () => {
    expect(namesFor("how do I reverse a pattern")).toContain("rev");
    expect(namesFor("add some reverb")).toContain("room");
    expect(namesFor("make it faster")).toContain("fast");
    expect(namesFor("chop a sample into pieces")).toContain("chop");
  });

  // Strudel abbreviates (`rev`, `seg`, `hpf`) and English inflects ("faster", "reversing").
  // Neither side matches the other without both stemming and prefix matching, and the
  // symptom of missing either is silent: retrieval returns *something*, just not the answer.
  it("bridges inflected words and abbreviated names", () => {
    expect(namesFor("reversing the melody")).toContain("rev");
    expect(namesFor("play it slower")).toContain("slow");
    expect(namesFor("segment the signal")).toContain("seg");
  });

  it("puts an explicitly named function first", () => {
    expect(namesFor("does ply exist?")[0]).toBe("ply");
  });

  // `room` says "reverb" once; roomlp/roomdim/roomfade each describe how the reverb behaves
  // and say it repeatedly. Unnormalised term counts rank the parameters above the function,
  // which is the wrong answer to "add reverb" in the most confident possible way.
  it("ranks the central function above its own sub-parameters", () => {
    const names = namesFor("add reverb");
    expect(names).toContain("room");
    // Every room* parameter that made the cut has to come after `room` itself — and the
    // stronger outcome, which is what actually happens now, is that they don't make it at
    // all. Comparing raw indexes would read a missing entry (-1) as "ranked first".
    const room = names.indexOf("room");
    for (const parameter of ["roomlp", "roomdim", "roomfade", "roomsize"]) {
      const at = names.indexOf(parameter);
      if (at !== -1) expect(room).toBeLessThan(at);
    }
  });

  // "pattern" is in half the requests anyone makes and is also a real export, alongside
  // isPattern and patternifyAST. An unweighted name match makes the base class the top hit.
  it("does not let a common word promote the internals named after it", () => {
    const names = namesFor("how do I reverse a pattern");
    expect(names.indexOf("rev")).toBeLessThan(names.indexOf("Pattern"));
  });

  it("always includes the foundations, which no request ever names", () => {
    // "give me a kick with a hat on the offbeat" needs s() and mentions nothing like it.
    const names = namesFor("four on the floor kick with offbeat hats");
    for (const core of CORE_FUNCTIONS) expect(names).toContain(core);
    expect(CORE_FUNCTIONS).toContain("s");
  });

  it("includes what the buffer already uses, whatever was asked", () => {
    const names = namesFor("make it more interesting", 'n("0 2 4").scale("c3:minor").room(0.4)');
    for (const used of ["n", "scale", "room"]) expect(names).toContain(used);
  });

  it("stays inside its character budget", () => {
    const { context } = retrieveDocs({ query: "reverb delay filter chop sample scale note", budget: 1500 });
    expect(context.length).toBeLessThanOrEqual(1500);
    expect(context).toContain("Strudel");
  });

  it("returns real, runnable examples rather than prose about them", () => {
    const { context } = retrieveDocs({ query: "reverse a pattern" });
    expect(context).toMatch(/e\.g\. .+/);
  });

  it("says nothing rather than something irrelevant for an empty query", () => {
    // Core functions still apply — they're what any request needs — but nothing is invented
    // from a query with no content.
    expect(retrieveDocs({ query: "" }).names).toEqual([...CORE_FUNCTIONS]);
  });
});
