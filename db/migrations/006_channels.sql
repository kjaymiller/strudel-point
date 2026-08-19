-- 006_channels.sql
-- A directory of rooms that have ever been joined, so the web client can list/switch
-- between them instead of only ever knowing the one channelId in its own URL hash.
-- Deliberately separate from tracks/autosaves/custom_samples: a channel shows up here the
-- moment someone joins it, even before it has any saved content.

create table if not exists channels (
  id              text primary key,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now()
);

create index if not exists channels_last_active_at_idx on channels (last_active_at desc);
