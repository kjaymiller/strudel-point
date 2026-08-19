-- Lets a set of custom_samples rows be grouped into one Strudel "bank" — e.g. slices cut
-- out of one beat by the client-side sample analyzer, meant to be played back as
-- s("mybeat:0"), s("mybeat:1"), etc. `name` stays the unique per-row identifier (storage/
-- lookup); bank_name/bank_index are purely about how the web app groups rows for playback.

alter table custom_samples add column if not exists bank_name text;
alter table custom_samples add column if not exists bank_index integer;

-- A given index within a bank can only be occupied once per channel (nulls are exempt —
-- ordinary, non-bank samples don't participate in this constraint).
create unique index if not exists custom_samples_bank_slot_idx
  on custom_samples (channel_id, bank_name, bank_index)
  where bank_name is not null;
