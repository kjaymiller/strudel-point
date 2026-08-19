-- 001_init.sql
-- Core schema for strudel-point: rooms are ephemeral (Kafka-backed), tracks are the
-- durable artifact a user chooses to save out of a room.

create extension if not exists pgcrypto;

create table if not exists tracks (
  id            uuid primary key default gen_random_uuid(),
  channel_id    text not null,
  title         text not null default 'untitled',
  author        text,
  code          text not null,
  strudel_json  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists tracks_channel_id_idx on tracks (channel_id);
create index if not exists tracks_created_at_idx on tracks (created_at desc);
create index if not exists tracks_strudel_json_gin_idx on tracks using gin (strudel_json);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tracks_set_updated_at on tracks;
create trigger tracks_set_updated_at
  before update on tracks
  for each row
  execute function set_updated_at();
