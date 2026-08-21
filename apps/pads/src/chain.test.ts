import { describe, expect, it } from "vitest";
import {
  buildRackCode,
  buildRecordingCode,
  estimateBpmFromHits,
  parseSliceRef,
  parseTrackBpm,
} from "./chain";

describe("parseSliceRef", () => {
  // Regression test: superdough looks up `s` as a literal registry key and never splits
  // this suffix itself — see the fix in apps/pads/src/App.tsx's previewLibrarySound and
  // apps/pads/src/components/PadGrid.tsx's isBankName, both of which depend on this
  // function actually splitting "bank:index" correctly.
  it("splits a bank:index ref into its bank name and slice index", () => {
    expect(parseSliceRef("Ahrix---ASTRA--NCS-Release-:5")).toEqual({
      s: "Ahrix---ASTRA--NCS-Release-",
      n: 5,
    });
  });

  it("defaults to slice 0 for a plain name with no colon", () => {
    expect(parseSliceRef("kick")).toEqual({ s: "kick", n: 0 });
  });

  it("falls back to the whole string when the suffix isn't numeric", () => {
    expect(parseSliceRef("weird:name")).toEqual({ s: "weird:name", n: 0 });
  });

  it("uses the last colon, not the first, for a bank name containing one", () => {
    expect(parseSliceRef("a:b:3")).toEqual({ s: "a:b", n: 3 });
  });
});

describe("parseTrackBpm", () => {
  it("reads bpm off a leading setcps(...) line", () => {
    // cps = bpm / 4 / 60, so bpm = cps * 4 * 60
    expect(parseTrackBpm('setcps(0.5)\ns("bd sn")')).toBeCloseTo(120, 5);
  });

  it("returns null when there's no leading setcps", () => {
    expect(parseTrackBpm('s("bd sn")')).toBeNull();
  });

  it("returns null for a non-positive or non-numeric cps", () => {
    expect(parseTrackBpm("setcps(0)")).toBeNull();
    expect(parseTrackBpm("setcps(-1)")).toBeNull();
    expect(parseTrackBpm("setcps(nope)")).toBeNull();
  });
});

describe("buildRackCode", () => {
  it("renders silence for an all-empty rack", () => {
    expect(buildRackCode([null, null, null])).toBe("silence");
  });

  it("renders each pad in order, empty pads as rests", () => {
    expect(buildRackCode(["kick:0", null, "snare:0"])).toBe('s("<kick:0 ~ snare:0>")');
  });
});

describe("buildRecordingCode", () => {
  it("renders silence for an empty recording", () => {
    expect(buildRecordingCode([], 120)).toBe("silence");
  });

  it("stacks simultaneous hits into one chord step and snaps solo hits to their own step", () => {
    // At 120bpm (4 beats/cycle -> one cycle = 2s), one 16th-note step is 125ms. Two hits
    // at t=0 land on step 0 together; a third at t=1000ms lands on step 8 of that same
    // 16-step cycle.
    const code = buildRecordingCode(
      [
        { ref: "kick:0", t: 0 },
        { ref: "hat:0", t: 0 },
        { ref: "snare:0", t: 1000 },
      ],
      120,
    );
    expect(code).toContain("setcps(0.5)");
    expect(code).toContain("[kick:0,hat:0]");
    expect(code).toMatch(/\.slow\(1\)$/);
    const steps = code.match(/s\("([^"]+)"\)/)?.[1].split(" ");
    expect(steps?.[8]).toBe("snare:0");
  });
});

describe("estimateBpmFromHits", () => {
  it("returns null with fewer than two distinct onsets", () => {
    expect(estimateBpmFromHits([])).toBeNull();
    expect(estimateBpmFromHits([{ ref: "kick:0", t: 0 }])).toBeNull();
  });

  it("merges near-simultaneous hits before estimating, so a chord isn't read as a gap", () => {
    // Two hits 10ms apart (well under the 30ms merge window) count as one onset — with
    // nothing else to compare it to, there's still only one onset and the result is null.
    expect(
      estimateBpmFromHits([
        { ref: "kick:0", t: 0 },
        { ref: "hat:0", t: 10 },
      ]),
    ).toBeNull();
  });

  it("estimates a plausible tempo from a steady quarter-note pulse", () => {
    // 500ms between hits = a quarter note at 120bpm (4 beats/cycle convention).
    const bpm = estimateBpmFromHits([
      { ref: "kick:0", t: 0 },
      { ref: "kick:0", t: 500 },
      { ref: "kick:0", t: 1000 },
      { ref: "kick:0", t: 1500 },
    ]);
    expect(bpm).not.toBeNull();
    expect(bpm).toBeGreaterThanOrEqual(40);
    expect(bpm).toBeLessThanOrEqual(300);
  });
});
