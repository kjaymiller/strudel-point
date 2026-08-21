// Sample-bank grouping — the same rule apps/pads' own groupBanks and apps/web's own
// registerAllSamples still implement independently: custom sample rows that share a
// `bankName` are slices of one playable Strudel bank (`s("bankName:0")`,
// `s("bankName:1")`, ...); everything else is a standalone one-shot. Centralized here so
// new callers don't have to re-derive it — see the duplicate-code audit for migrating
// pads'/web's own copies onto this one.
import type { CustomSample } from "@strudel-point/shared";

export interface SampleBank {
  bankName: string;
  /** Sorted by bankIndex — playback order within the bank. */
  slices: CustomSample[];
}

/** Turns a dropped file's own name into a legal sample/bank name — same
 * `[a-zA-Z0-9_-]{1,64}` rule the gateway enforces server-side, so this never gets
 * rejected on upload. Used both for a fresh file drop's suggested name and to seed a
 * merged-sources name in the sample editor (see SampleEditor.tsx). */
export function suggestName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 64) || "sample"
  );
}

/** The string that's actually playable in Strudel for a given row — a bank slice only
 * ever gets registered as part of its bank (`samples({ [bankName]: [...] })`), never
 * under its own row-level `name`, so `bankName:bankIndex` is the one that resolves. */
export function playableName(s: CustomSample): string {
  return s.bankName ? `${s.bankName}:${s.bankIndex}` : s.name;
}

export function groupSampleBanks(samples: CustomSample[]): { banks: SampleBank[]; singles: CustomSample[] } {
  const grouped = new Map<string, CustomSample[]>();
  const singles: CustomSample[] = [];
  for (const s of samples) {
    if (s.bankName) grouped.set(s.bankName, [...(grouped.get(s.bankName) ?? []), s]);
    else singles.push(s);
  }
  const banks = [...grouped.entries()]
    .map(([bankName, slices]) => ({
      bankName,
      slices: slices.slice().sort((a, b) => (a.bankIndex ?? 0) - (b.bankIndex ?? 0)),
    }))
    .sort((a, b) => a.bankName.localeCompare(b.bankName));
  return { banks, singles };
}

/** A bank's slice URLs in playback order — hand straight to
 * `samples({ [bank.bankName]: bankSampleUrls(bank) })`. */
export function bankSampleUrls(bank: SampleBank): string[] {
  return bank.slices.map((s) => s.url);
}
