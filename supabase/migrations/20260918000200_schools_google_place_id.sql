-- Google's place ID is the stable identity of a school in the ingest (names and coordinates are not),
-- and Google allows place IDs to be stored. The ingest function upserts on this column.
-- Multiple NULLs are allowed, so the existing rows are unaffected until the ingest backfills them.
alter table public.schools add column if not exists google_place_id text unique;
