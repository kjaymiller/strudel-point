// Fetches the two things a room's "library tray" (see LibraryTray.tsx) shows — saved
// Tracks and custom sample uploads — for a given channel. Doesn't touch any app's own
// Strudel sound registry itself: every app (web/dj/pads/patch-panel) has its own
// singleton with its own prebake (see apps/*/src/strudel.ts), so registering fetched
// samples into it is the caller's job via `onSamples` below.

import type { CustomSample, Track } from "@strudel-point/shared";
import { useCallback, useEffect, useState } from "react";

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `request failed with ${res.status}`);
  }
  return res.json();
}

export interface ChannelLibrary {
  tracks: Track[];
  customSamples: CustomSample[];
  loading: boolean;
  error: string | null;
  /** Re-fetches both lists — call this after a `sample:added`/`sample:removed`/
   * `bank:renamed` channel event, same "cheapest correct response is just refetch"
   * approach apps/pads' own refreshBanks already used. */
  refresh: () => Promise<void>;
}

/**
 * `onSamples`, if given, runs once after every successful fetch (initial load and every
 * `refresh()`) with the freshly-fetched sample list — the hook doesn't call it on a
 * timer or depend on its identity for anything besides that one call, so passing an
 * inline arrow function each render is fine; no need to useCallback it.
 */
export function useChannelLibrary(
  channelId: string,
  onSamples?: (samples: CustomSample[]) => void,
): ChannelLibrary {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [customSamples, setCustomSamples] = useState<CustomSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextTracks, nextSamples] = await Promise.all([
        fetch(`/api/channels/${channelId}/tracks`).then(jsonOrThrow) as Promise<Track[]>,
        fetch(`/api/channels/${channelId}/samples`).then(jsonOrThrow) as Promise<CustomSample[]>,
      ]);
      setTracks(nextTracks);
      setCustomSamples(nextSamples);
      onSamples?.(nextSamples);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // onSamples deliberately excluded — see this function's own doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  return { tracks, customSamples, loading, error, refresh };
}
