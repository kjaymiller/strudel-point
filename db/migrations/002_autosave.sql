-- 002_autosave.sql
-- One row per channel, upserted in place — a "last known state" for a room's buffer,
-- distinct from the tracks table where every save() is a new row a user chose to keep.

create table if not exists autosaves (
  channel_id    text primary key,
  code          text not null,
  strudel_json  jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

drop trigger if exists autosaves_set_updated_at on autosaves;
create trigger autosaves_set_updated_at
  before update on autosaves
  for each row
  execute function set_updated_at();
