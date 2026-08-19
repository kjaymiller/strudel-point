// Deterministic per-bank color, so every bank reads as "that same color" everywhere it
// shows up (a pad, the sample shelf) — across the grid, across the shelf, and across a
// reload — without anyone needing to pick colors by hand.

/** Hue (0-359) hashed from a bank name — same string always maps to the same hue. Not
 * cryptographic, just a cheap rolling hash; collisions between unrelated bank names
 * landing on similar hues are a cosmetic non-issue, not a correctness one. */
export function hueForBank(bankName: string): number {
  let hash = 0;
  for (let i = 0; i < bankName.length; i++) {
    hash = (hash * 31 + bankName.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
