// The non-function half of Strudel, from strudelVocabulary.json (see
// scripts/build-strudel-vocab.ts): mini-notation syntax, the sample names that actually
// resolve in this app, the banks .bank() takes, and the scales .scale() accepts.
//
// strudelApi.json can't cover any of this — `~`, `*4`, `[a b]` and `(3,8)` are a grammar
// rather than an API, and sample and scale names are data. That gap is where a small model's
// mistakes have actually landed: `4` used as a rest, `s("4*4")` as a drum pattern. The
// function index it did have was never the part it got wrong.

import raw from "./strudelVocabulary.json" with { type: "json" };

interface MiniNotationForm {
  syntax: string;
  means: string;
  example: string;
}

const vocab = raw as {
  miniNotation: MiniNotationForm[];
  samples: string[];
  banks: string[];
  scales: string[];
};

export const SAMPLES: readonly string[] = vocab.samples;
export const BANKS: readonly string[] = vocab.banks;
export const SCALES: readonly string[] = vocab.scales;
export const MINI_NOTATION: readonly MiniNotationForm[] = vocab.miniNotation;

/** Cheap "is this request about X" tests, used to keep the block short. */
const MELODIC = /\b(scale|note|melod|chord|key|pitch|bass|lead|arp|major|minor|harmon|tune|interval)/i;
const PERCUSSIVE = /\b(bank|drum ?machine|808|909|707|tr\d|linn|kit)/i;

/**
 * The always-present vocabulary block.
 *
 * Sample names and mini-notation go in every turn: they are the two things a model cannot
 * derive and will otherwise invent. Scales and banks are long lists that only matter to
 * some requests, so they are included when the request or the buffer suggests they will be
 * — a 9B model reading 90 scale names to add a hi-hat is spending attention it needs
 * elsewhere.
 */
export function vocabularyBlock({ query, code = "" }: { query: string; code?: string }): string {
  const text = `${query}\n${code}`;
  const sections: string[] = [];

  sections.push(
    "Mini-notation — the language inside the quotes. This is a grammar, not functions, so none\n" +
      "of it appears in the reference above:\n" +
      MINI_NOTATION.map(
        (form) => `  ${form.syntax.padEnd(8)} ${form.means}\n${" ".repeat(11)}e.g. "${form.example}"`,
      ).join("\n"),
  );

  sections.push(
    `Sample names that resolve here — s("...") accepts these and nothing else. A name not on\n` +
      "this list loads no audio and plays silence, which is the failure nobody in the room can\n" +
      "hear the cause of:\n  " +
      SAMPLES.join(" "),
  );

  if (MELODIC.test(text)) {
    sections.push(`Scales for .scale("c3:NAME") / .scale("NAME"):\n  ${SCALES.join(", ")}`);
    sections.push(
      "Notes are letter + optional accidental + octave: c3, eb3, f#4, a2. Scale degrees are\n" +
        'plain integers through n(...): n("0 2 4").scale("c3:minor").',
    );
  }

  if (PERCUSSIVE.test(text)) {
    sections.push(`Banks for .bank("..."):\n  ${BANKS.join(" ")}`);
  }

  return sections.join("\n\n");
}
