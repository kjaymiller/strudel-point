import type { CustomSample } from "@strudel-point/shared";
import { describe, expect, it } from "vitest";
import { bankSampleUrls, groupSampleBanks, playableName, suggestName } from "./banks";

function sample(overrides: Partial<CustomSample> & { id: string }): CustomSample {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    url: overrides.url ?? `https://example.test/${overrides.id}`,
    bankName: overrides.bankName,
    bankIndex: overrides.bankIndex,
  } as CustomSample;
}

describe("suggestName", () => {
  it("strips the extension and replaces illegal characters", () => {
    expect(suggestName("Ahrix - ASTRA (NCS Release).mp3")).toBe("Ahrix---ASTRA--NCS-Release-");
  });

  it("falls back to 'sample' when nothing legal survives", () => {
    expect(suggestName("###.wav")).toBe("---");
    expect(suggestName(".wav")).toBe("sample");
  });

  it("truncates to 64 characters", () => {
    const long = `${"a".repeat(100)}.wav`;
    expect(suggestName(long)).toHaveLength(64);
  });
});

describe("playableName", () => {
  it("returns bankName:bankIndex for a bank slice", () => {
    expect(playableName(sample({ id: "s1", bankName: "kicks", bankIndex: 5 }))).toBe("kicks:5");
  });

  it("returns the bare name for a single sample with no bank", () => {
    expect(playableName(sample({ id: "s1", name: "stem-vocals" }))).toBe("stem-vocals");
  });
});

describe("groupSampleBanks", () => {
  it("groups slices sharing a bankName and sorts them by bankIndex", () => {
    const { banks, singles } = groupSampleBanks([
      sample({ id: "a", bankName: "kicks", bankIndex: 1 }),
      sample({ id: "b", bankName: "kicks", bankIndex: 0 }),
    ]);
    expect(singles).toHaveLength(0);
    expect(banks).toHaveLength(1);
    expect(banks[0].bankName).toBe("kicks");
    expect(banks[0].slices.map((s) => s.id)).toEqual(["b", "a"]);
  });

  // Regression test: a stem (no bankName of its own) must land in `singles`, not get
  // mistaken for a multi-slice bank — see the PadGrid.tsx drop-target fix, which relies
  // on singles staying distinguishable from real banks so a dropped stem lands on the
  // pad it was dropped on instead of always overwriting pad 0.
  it("puts samples with no bankName into singles, not banks", () => {
    const { banks, singles } = groupSampleBanks([sample({ id: "stem-vocals" })]);
    expect(banks).toHaveLength(0);
    expect(singles.map((s) => s.id)).toEqual(["stem-vocals"]);
  });

  it("sorts banks by name and handles a mix of banks and singles", () => {
    const { banks, singles } = groupSampleBanks([
      sample({ id: "z1", bankName: "zebra", bankIndex: 0 }),
      sample({ id: "stem" }),
      sample({ id: "a1", bankName: "aardvark", bankIndex: 0 }),
    ]);
    expect(banks.map((b) => b.bankName)).toEqual(["aardvark", "zebra"]);
    expect(singles.map((s) => s.id)).toEqual(["stem"]);
  });
});

describe("bankSampleUrls", () => {
  it("returns slice urls in playback order", () => {
    const { banks } = groupSampleBanks([
      sample({ id: "a", bankName: "kicks", bankIndex: 0, url: "https://example.test/a" }),
      sample({ id: "b", bankName: "kicks", bankIndex: 1, url: "https://example.test/b" }),
    ]);
    expect(bankSampleUrls(banks[0])).toEqual(["https://example.test/a", "https://example.test/b"]);
  });
});
