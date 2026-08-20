// Client-side call to the gateway's stem-separation route (see
// apps/gateway/src/routes/stems.ts, which forwards to the Spleeter service — see
// apps/spleeter). Deliberately just the network call: registering the resulting samples
// with an app's own Strudel module and broadcasting `sample:added` for each one is left
// to the caller, same "app owns its own registry/socket, this package only fetches"
// split as useChannelLibrary.
import type { CustomSample } from "@strudel-point/shared";

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `request failed with ${res.status}`);
  }
  return res.json();
}

/**
 * Uploads `file` (a whole sample, not yet cut into slices) for stem separation, scoped to
 * `channelId`, and returns the resulting stems as ordinary new CustomSample rows —
 * `${baseName}_vocals`, `${baseName}_drums`, etc — already stored server-side and
 * immediately playable via their own `url`. Synchronous from the caller's point of view:
 * this resolves only once the whole separation has finished, which is slow (real
 * CPU-bound ML inference), so show real loading state around this call rather than
 * assuming it returns quickly.
 */
export async function requestStemSeparation(channelId: string, file: File, baseName: string): Promise<CustomSample[]> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", baseName);
  return fetch(`/api/channels/${channelId}/samples/separate`, { method: "POST", body: form }).then(jsonOrThrow);
}
