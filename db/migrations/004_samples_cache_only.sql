-- 004_samples_cache_only.sql
-- Audio bytes moved to Valkey (24h sliding TTL, see apps/gateway/src/cache.ts) — holding
-- them in Postgres was unbounded growth for what's meant to be session-scoped material.
-- This table is metadata-only from here on; the row itself gets deleted once the cache
-- entry it points at has expired (see routes/samples.ts's list handler).

alter table custom_samples drop column if exists data;
