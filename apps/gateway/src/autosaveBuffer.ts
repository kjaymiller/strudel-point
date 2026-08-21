import type { AutosaveDoc, StrudelJson } from "@strudel-point/shared";
import { pool } from "./db.js";
import { autosaveFlushErrorsTotal, autosaveFlushesTotal } from "./metrics.js";
import { isValkeyReady, withValkey } from "./valkey.js";

// The web client debounces autosave to 3s (AUTOSAVE_DEBOUNCE_MS in apps/web/src/App.tsx)
// and also fires one immediately on every evaluate — so a room with someone actively
// typing was doing an UPSERT into `autosaves` roughly every three seconds, per room,
// forever. That's a lot of write amplification for a row nobody reads until someone
// reloads the page.
//
// So: writes land in Valkey and the channel is marked dirty; a flusher drains the dirty
// set into Postgres on an interval. Postgres stays the durable copy — this only changes
// *when* it's written, not whether. Reads come from Valkey when warm, Postgres when cold
// (and warm the cache on the way through).
//
// The trade, stated plainly: a Valkey loss between flushes loses up to FLUSH_INTERVAL_MS
// of autosave. That's acceptable *here specifically* because autosave is already the
// explicitly-lossy tier — a debounced best-effort snapshot, deliberately distinct from a
// saved Track, which still writes straight to Postgres synchronously (see routes/tracks.ts
// and the README's "different durability tiers" note). It would not be acceptable for
// tracks, and this pattern shouldn't be copied there.
const bufferKey = (channelId: string) => `autosave:${channelId}`;
const DIRTY_SET = "autosave:dirty";

// Long enough that a room's buffer is still warm across a lunch break, short enough that
// Valkey isn't quietly accumulating every room that ever existed. A cold read just falls
// through to Postgres, which by then holds the flushed value anyway.
const BUFFER_TTL_SECONDS = 7 * 24 * 60 * 60;

const FLUSH_INTERVAL_MS = 15_000;

// One SPOP claims at most this many channels per tick. Bounded so a burst can't turn one
// flush into an unbounded serial run of UPSERTs; anything left over is still in the dirty
// set for the next tick.
const FLUSH_BATCH = 200;

interface BufferedDoc {
  code: string;
  strudelJson: StrudelJson;
  updatedAt: string;
}

/** GET path: Valkey first, Postgres on a miss (warming Valkey so the next read is cheap). */
export async function readAutosave(channelId: string): Promise<AutosaveDoc | null> {
  const cached = await withValkey<string | null>(
    "autosave.read",
    (client) => client.get(bufferKey(channelId)),
    null,
  );
  if (cached) {
    const doc = JSON.parse(cached) as BufferedDoc;
    return { channelId, ...doc };
  }

  const { rows } = await pool.query(`select * from autosaves where channel_id = $1`, [channelId]);
  if (rows.length === 0) return null;

  const doc: BufferedDoc = {
    code: rows[0].code,
    strudelJson: rows[0].strudel_json,
    updatedAt: rows[0].updated_at,
  };
  // Warm, but do NOT mark dirty — this value came *from* Postgres, so flushing it back
  // would be a pointless write of data that's already there.
  await withValkey(
    "autosave.warm",
    (client) => client.set(bufferKey(channelId), JSON.stringify(doc), "EX", BUFFER_TTL_SECONDS),
    null,
  );
  return { channelId, ...doc };
}

/** PUT path: buffer in Valkey and return immediately; Postgres write-through if it's down. */
export async function writeAutosave(
  channelId: string,
  code: string,
  strudelJson: StrudelJson,
): Promise<AutosaveDoc> {
  if (!isValkeyReady()) return writeAutosaveToPostgres(channelId, code, strudelJson);

  // Generated here rather than read back from Postgres' `updated_at` trigger, since the
  // whole point is not to touch Postgres on this path. The client only uses it to render
  // "saved just now", so gateway clock is good enough.
  const doc: BufferedDoc = { code, strudelJson, updatedAt: new Date().toISOString() };

  const buffered = await withValkey(
    "autosave.write",
    async (client) => {
      await client
        .multi()
        .set(bufferKey(channelId), JSON.stringify(doc), "EX", BUFFER_TTL_SECONDS)
        .sadd(DIRTY_SET, channelId)
        .exec();
      return true;
    },
    false,
  );
  if (!buffered) return writeAutosaveToPostgres(channelId, code, strudelJson);

  return { channelId, ...doc };
}

async function writeAutosaveToPostgres(
  channelId: string,
  code: string,
  strudelJson: StrudelJson,
): Promise<AutosaveDoc> {
  const { rows } = await pool.query(
    `insert into autosaves (channel_id, code, strudel_json)
     values ($1, $2, $3::jsonb)
     on conflict (channel_id) do update
       set code = excluded.code, strudel_json = excluded.strudel_json
     returning *`,
    [channelId, code, JSON.stringify(strudelJson)],
  );
  return {
    channelId: rows[0].channel_id,
    code: rows[0].code,
    strudelJson: rows[0].strudel_json,
    updatedAt: rows[0].updated_at,
  };
}

/**
 * Drains the dirty set into Postgres. Safe to run on every gateway instance concurrently:
 * SPOP *claims* channels atomically, so two instances can't both flush the same one, and a
 * write that lands after the pop simply re-adds the channel for the next tick (rather than
 * being lost, which is what re-reading and then SREMing would do).
 */
export async function flushAutosaves(): Promise<number> {
  const channelIds = await withValkey<string[]>(
    "autosave.claim",
    (client) => client.spop(DIRTY_SET, FLUSH_BATCH),
    [],
  );
  if (channelIds.length === 0) return 0;

  let flushed = 0;
  for (const channelId of channelIds) {
    const raw = await withValkey<string | null>(
      "autosave.flushRead",
      (client) => client.get(bufferKey(channelId)),
      null,
    );
    // Buffer expired out from under its dirty marker — nothing left to persist.
    if (!raw) continue;

    try {
      const doc = JSON.parse(raw) as BufferedDoc;
      await writeAutosaveToPostgres(channelId, doc.code, doc.strudelJson);
      flushed++;
      autosaveFlushesTotal.inc();
    } catch (err) {
      console.error(`failed to flush autosave for channel ${channelId}`, err);
      autosaveFlushErrorsTotal.inc();
      // Put it back so the next tick retries, rather than dropping the buffered edit
      // because Postgres was briefly unavailable.
      await withValkey("autosave.requeue", (client) => client.sadd(DIRTY_SET, channelId), 0);
    }
  }
  return flushed;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startAutosaveFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushAutosaves().catch((err) => console.error("autosave flush tick failed", err));
  }, FLUSH_INTERVAL_MS);
}

/** Stops the timer and drains whatever's still buffered — the graceful-shutdown half. */
export async function stopAutosaveFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  const flushed = await flushAutosaves().catch((err) => {
    console.error("final autosave flush failed", err);
    return 0;
  });
  if (flushed > 0) console.log(`flushed ${flushed} buffered autosave(s) on shutdown`);
}
