// Pure helpers over a cable list — `cableKey(from, to)` strings, `from`/`to` being
// "moduleId:jackId" addresses (see modules.ts's jackAddress). Deliberately dumb: nothing
// here knows about jack roles, capacities, or which modules exist — that validation lives
// in PatchBay.tsx (against its own live registered-jack metadata, for the drag
// interaction) since it doesn't need a copy of the module list to do it. These helpers are
// what patch.ts's codegen (expressionAt) uses to walk a stored cable list.

export function cableKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function hasCable(cables: Iterable<string>, from: string, to: string): boolean {
  const key = cableKey(from, to);
  for (const c of cables) if (c === key) return true;
  return false;
}

/** Every destination a given source is currently cabled to — plural, since every source
 * jack in this rack fans out freely (see modules.ts's jackCapacity): one Sequencer's
 * note-out can feed several VCOs, one VCO's audio-out can feed several Channels, etc. */
export function destinationsFrom(cables: Iterable<string>, source: string): string[] {
  const out: string[] = [];
  for (const c of cables) {
    const i = c.indexOf("->");
    if (c.slice(0, i) === source) out.push(c.slice(i + 2));
  }
  return out;
}

/** Every source currently cabled into this destination — plural because CV inputs
 * (cutoff/pitch-mod-in) and a Channel's or the master Output's audio-in are passive
 * summing jacks that can carry more than one incoming cable (see modules.ts's
 * jackCapacity). */
export function sourcesTo(cables: Iterable<string>, destination: string): string[] {
  const out: string[] = [];
  for (const c of cables) {
    const i = c.indexOf("->");
    if (c.slice(i + 2) === destination) out.push(c.slice(0, i));
  }
  return out;
}
