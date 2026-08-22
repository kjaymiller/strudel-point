import { describe, expect, it } from "vitest";
import { sampleAudioUrl } from "./samples.js";

describe("sampleAudioUrl", () => {
  const ID = "008d4a63-293f-4bff-9a92-872a4f660130";

  it("keeps the id-addressed path so the route still matches", () => {
    expect(sampleAudioUrl(ID, "2026-08-22T02:47:20.302Z")).toContain(`/api/samples/${ID}/audio`);
  });

  // The regression this file exists for. Editing a sample re-uploads under the same name,
  // which upserts on (channel_id, name): same row, same id, new bytes, new created_at.
  // If the URL doesn't move with the bytes, Strudel's URL-keyed AudioBuffer cache (and the
  // browser's max-age=3600) keep serving the previous audio, so the sample plays back as
  // whatever it used to be.
  it("changes when the bytes are replaced, even though the id does not", () => {
    const before = sampleAudioUrl(ID, "2026-08-22T02:47:20.302Z");
    const after = sampleAudioUrl(ID, "2026-08-22T02:47:20.412Z");
    expect(after).not.toEqual(before);
  });

  it("is stable for an unchanged row, so an unedited sample stays cacheable", () => {
    const at = "2026-08-22T02:47:20.302Z";
    expect(sampleAudioUrl(ID, at)).toEqual(sampleAudioUrl(ID, at));
  });

  it("accepts a Date as well as a string — pg returns timestamptz as a Date", () => {
    const at = "2026-08-22T02:47:20.302Z";
    expect(sampleAudioUrl(ID, new Date(at))).toEqual(sampleAudioUrl(ID, at));
  });
});
