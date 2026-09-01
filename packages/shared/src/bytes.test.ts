import { describe, expect, it } from "vitest";
import { appendCommented, bytesToSequence } from "./bytes.js";

const bytes = (...values: number[]) => new Uint8Array(values);

/** A deterministic pseudo-file, so tests don't depend on Math.random. */
function fakeFile(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state >> 16) & 0xff;
  }
  return out;
}

describe("bytesToSequence", () => {
  it("is deterministic — the same bytes always give the same sequence", () => {
    const file = fakeFile(4096);
    expect(bytesToSequence(file).notation).toEqual(bytesToSequence(file).notation);
    expect(bytesToSequence(file).steps).toEqual(bytesToSequence(file).steps);
  });

  // The whole point of folding every byte rather than sampling: a change anywhere in the
  // file has to be audible, including deep inside a large one.
  it("hears a single flipped byte in the middle of a large file", () => {
    const file = fakeFile(8192);
    const edited = new Uint8Array(file);
    edited[3000] ^= 0xff;
    expect(bytesToSequence(edited).notation).not.toEqual(bytesToSequence(file).notation);
  });

  it("hears order, not just content", () => {
    const forward = fakeFile(2048);
    const reversed = new Uint8Array([...forward].reverse());
    expect(bytesToSequence(reversed).notation).not.toEqual(bytesToSequence(forward).notation);
  });

  it("emits nothing but numbers and rests", () => {
    const { notation } = bytesToSequence(fakeFile(512));
    for (const token of notation.split(/\s+/)) {
      expect(token).toMatch(/^(\d+|~)$/);
    }
  });

  it("keeps every number inside the requested range", () => {
    for (const range of [2, 5, 8, 16]) {
      const { steps } = bytesToSequence(fakeFile(1024), { range });
      for (const step of steps) {
        if (step !== null) {
          expect(step).toBeGreaterThanOrEqual(0);
          expect(step).toBeLessThan(range);
        }
      }
    }
  });

  it("lets the bytes pick a length inside the min/max band", () => {
    // Every file must land in the band, and across enough files the length must actually
    // vary — a band that always returns its floor would be a fixed length wearing a hat.
    const lengths = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const { steps } = bytesToSequence(fakeFile(300, seed), { minSteps: 6, maxSteps: 12 });
      expect(steps.length).toBeGreaterThanOrEqual(6);
      expect(steps.length).toBeLessThanOrEqual(12);
      lengths.add(steps.length);
    }
    expect(lengths.size).toBeGreaterThan(1);
  });

  it("honours an explicit length, clamped to the band", () => {
    expect(bytesToSequence(fakeFile(256), { steps: 5, minSteps: 1, maxSteps: 64 }).steps).toHaveLength(5);
    expect(bytesToSequence(fakeFile(256), { steps: 5000 }).steps).toHaveLength(32);
    expect(bytesToSequence(fakeFile(256), { steps: 0 }).steps).toHaveLength(8);
  });

  it("obeys the rest density at both extremes", () => {
    const file = fakeFile(2048);
    expect(bytesToSequence(file, { rest: 0, steps: 32 }).steps.some((s) => s === null)).toBe(false);
    expect(bytesToSequence(file, { rest: 1, steps: 32 }).steps.every((s) => s === null)).toBe(true);
  });

  it("puts more rests in as the density rises", () => {
    const file = fakeFile(4096);
    const restsAt = (rest: number) =>
      bytesToSequence(file, { rest, steps: 64, minSteps: 64 }).steps.filter((s) => s === null).length;
    expect(restsAt(0.75)).toBeGreaterThan(restsAt(0.25));
  });

  // A rest is `~`. `-` looks like a rest but mini-notation doesn't read it as one, so a
  // sequence using it would play wrong rather than fail loudly.
  it("spells rests the way Strudel spells them", () => {
    const allRests = bytesToSequence(fakeFile(64), { rest: 1, steps: 8 });
    expect(allRests.notation).not.toContain("-");
    expect(allRests.notation.split(/\s+/).every((token) => token === "~")).toBe(true);
  });

  it("survives an empty file", () => {
    const { steps, notation, bytesRead } = bytesToSequence(new Uint8Array());
    expect(bytesRead).toBe(0);
    expect(steps.length).toBeGreaterThan(0);
    // No bytes means no notes; silence is the honest answer, not a crash or a fake pattern.
    expect(steps.every((step) => step === null)).toBe(true);
    expect(notation).toContain("~");
  });

  // The filename lands in a `//` header comment, so a name crafted to close the comment
  // would be running its own code in everyone's browser.
  it("neutralises a filename that tries to escape the comment", () => {
    const { code } = bytesToSequence(bytes(1, 2, 3), { label: "evil */\nhush() //.wav" });
    expect(code).not.toContain("*/");
    for (const line of code.split("\n")) {
      if (line.includes("hush()")) expect(line.trimStart().startsWith("//")).toBe(true);
    }
  });

  it("emits something a browser can actually parse", () => {
    for (const label of ["kick.wav", 'weird")name.wav', "back\\slash.wav", "*/ nope"]) {
      const { code } = bytesToSequence(fakeFile(200), { label });
      expect(() => new Function(code)).not.toThrow();
    }
  });

  it("emits a bare n(...) that any instrument can be chained onto", () => {
    const { code, notation } = bytesToSequence(fakeFile(128), { steps: 8 });
    expect(code).toContain(`n("${notation}")`);
    // Nothing opinionated about key, tempo or voice — that's the caller's to choose.
    expect(code).not.toContain("scale(");
    expect(code).not.toContain("setcpm");
    expect(code).not.toContain("stack(");
    expect(() => new Function(`${code}.sound("piano")`)).not.toThrow();
  });
});

// A drop lands in a buffer other people are looking at and probably listening to. It used
// to replace it, which is how someone's work disappears mid-session because a third person
// dropped a PNG on a chat panel.
describe("appendCommented", () => {
  it("leaves what is already playing exactly as it was", () => {
    const existing = 'stack(s("bd*4"), s("~ hh ~ hh"))';
    const result = appendCommented(existing, 'n("0 2 4")');
    expect(result.startsWith(existing)).toBe(true);
  });

  it("comments every line it adds, so nothing new plays", () => {
    const result = appendCommented('s("bd*4")', '// 12 bytes of "x.png" -> 8 steps\nn("0 2 ~ 4")');
    const added = result.slice('s("bd*4")'.length);
    for (const line of added.split("\n")) {
      if (line.trim().length > 0) expect(line.trimStart().startsWith("//")).toBe(true);
    }
    expect(added).toContain('n("0 2 ~ 4")');
  });

  it("does not double up the header comment the generator already wrote", () => {
    const { code } = bytesToSequence(fakeFile(64), { label: "x.png" });
    expect(appendCommented("", code)).not.toContain("// //");
  });

  it("starts cleanly in an empty buffer instead of leading with blank lines", () => {
    expect(appendCommented("", 'n("0 2")')).toBe('// n("0 2")\n');
    expect(appendCommented("   \n\n", 'n("0 2")')).toBe('// n("0 2")\n');
  });

  it("separates the block from the pattern above it", () => {
    expect(appendCommented('s("bd")', 'n("0")')).toBe('s("bd")\n\n// n("0")\n');
  });

  it("still parses as JavaScript once appended, however many drops land", () => {
    let buffer = 'stack(s("bd*4"))';
    for (let seed = 1; seed <= 3; seed++) {
      buffer = appendCommented(buffer, bytesToSequence(fakeFile(128, seed), { label: `f${seed}.bin` }).code);
    }
    expect(() => new Function(buffer)).not.toThrow();
    expect(buffer.match(/^\/\/ n\(/gm)?.length).toBe(3);
  });
});
