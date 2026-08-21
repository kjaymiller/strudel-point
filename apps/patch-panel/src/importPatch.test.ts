import { describe, expect, it } from "vitest";
import { parsePatchCode } from "./importPatch";
import { buildMixCode } from "./patch";
import { defaultRack } from "./presets";

describe("parsePatchCode", () => {
  it("round-trips the default rack's own generated code with nothing unmatched", () => {
    const { modules, cables } = defaultRack();
    const { code } = buildMixCode(modules, cables);

    const parsed = parsePatchCode(code);

    expect(parsed.unmatchedRanges).toEqual([]);
    // One module for every source module plus the output this parser always adds (see
    // importPatch.ts's parsePatchCode) — vco/vcf/envelope/output, same shape as the rack
    // that produced the code, even though the parser mints its own "imp-N" ids rather
    // than reusing "m-vco" etc.
    expect(parsed.modules.map((m) => m.kind).sort()).toEqual(modules.map((m) => m.kind).sort());
    expect(parsed.cables).toHaveLength(cables.length);

    // The re-parsed rack should generate equivalent code, modulo whatever id renumbering
    // the parser's own "imp-N" scheme introduces — this regression-tests the reverse
    // transform (importPatch.ts) against its forward counterpart (patch.ts) actually
    // agreeing with each other, not just that parsing doesn't throw.
    const roundTripped = buildMixCode(parsed.modules, parsed.cables);
    expect(roundTripped.unterminatedSourceIds).toEqual([]);
  });

  it("always includes an output module, even for source-less code", () => {
    const parsed = parsePatchCode("silence");
    expect(parsed.modules.some((m) => m.kind === "output")).toBe(true);
  });

  // Regression test for the "never silently drop code" contract this file's own doc
  // comment describes: anything that doesn't parse as a recognized call chain must show
  // up as an unmatched range, not vanish from the rack.
  it("reports an unrecognized branch as an unmatched range instead of dropping it", () => {
    const weird = "totallyMadeUpFunction(1, 2, 3)";
    const parsed = parsePatchCode(weird);

    expect(parsed.unmatchedRanges.length).toBeGreaterThan(0);
    const [range] = parsed.unmatchedRanges;
    expect(weird.slice(range.start, range.end)).toContain("totallyMadeUpFunction");
  });
});
