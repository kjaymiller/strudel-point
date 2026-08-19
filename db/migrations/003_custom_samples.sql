-- 003_custom_samples.sql
-- User-uploaded audio, scoped per channel. Stored as bytea directly in Postgres — fine
-- for the one-shots/short loops this is meant for (upload is capped at 10MB in the
-- gateway); revisit if this needs to hold long recordings or grows past a modest volume.

create table if not exists custom_samples (
  id            uuid primary key default gen_random_uuid(),
  channel_id    text not null,
  name          text not null,
  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer not null,
  data          bytea not null,
  created_at    timestamptz not null default now(),
  unique (channel_id, name)
);

create index if not exists custom_samples_channel_id_idx on custom_samples (channel_id);
