-- supabase/migrations/20260921000200_parent_addresses.sql
--
-- A parent's own address book: the handful of places they look for schools from.
--
-- The app has no street-address lookup, so a place is saved where the parent is standing: they turn their location on
-- at home, name it "Home", and from then on they can search around home from anywhere. Each saved place is a name, a
-- line of address text they write themselves so they can tell one from another, and the coordinates they saved it at.
--
-- This is a private list. Nobody but its owner can read it: not a school, not another parent, not a signed-out
-- visitor. A parent can rename, move and remove their own places, and nothing else about them.
--
-- Needs 20260918000100 (the roles) first. Safe to run more than once.

create table if not exists public.parent_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 40),
  address text check (address is null or char_length(address) <= 160),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_at timestamptz not null default now()
);
create index if not exists parent_addresses_user_idx on public.parent_addresses (user_id, created_at);

-- One "Home" per person. Two places with the same name would be a puzzle, not a choice, and " home " is the same
-- name as "Home" to the person typing it.
create unique index if not exists parent_addresses_one_label_each
  on public.parent_addresses (user_id, lower(btrim(label)));

-- ---- tidying, so the list reads the same however it was written -----------------------------------------------------
create or replace function public.parent_addresses_tidy()
 returns trigger
 language plpgsql
 set search_path = ''
as $$
begin
  new.label := btrim(new.label);
  new.address := nullif(btrim(new.address), '');
  return new;
end;
$$;
drop trigger if exists parent_addresses_tidy on public.parent_addresses;
create trigger parent_addresses_tidy before insert or update on public.parent_addresses
  for each row execute function public.parent_addresses_tidy();

-- ---- how many ------------------------------------------------------------------------------------------------------
-- An address book, not a map of everywhere anyone has been. Six is more than a family needs and small enough that
-- picking from the list stays quicker than turning the location on.
create or replace function public.parent_addresses_limit()
 returns trigger
 language plpgsql
 set search_path = ''
as $$
begin
  if (select count(*) from public.parent_addresses where user_id = new.user_id) > 6 then
    raise exception 'You can keep up to 6 places' using errcode = '23514';
  end if;
  return null;
end;
$$;
drop trigger if exists parent_addresses_limit on public.parent_addresses;
create trigger parent_addresses_limit after insert on public.parent_addresses
  for each row execute function public.parent_addresses_limit();

-- ---- who may see and change what -----------------------------------------------------------------------------------
alter table public.parent_addresses enable row level security;

drop policy if exists "People see their own places" on public.parent_addresses;
create policy "People see their own places" on public.parent_addresses
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "People add their own places" on public.parent_addresses;
create policy "People add their own places" on public.parent_addresses
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "People change their own places" on public.parent_addresses;
create policy "People change their own places" on public.parent_addresses
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "People remove their own places" on public.parent_addresses;
create policy "People remove their own places" on public.parent_addresses
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.parent_addresses from anon, authenticated;
grant select, delete on public.parent_addresses to authenticated;
grant insert (user_id, label, address, latitude, longitude) on public.parent_addresses to authenticated;
grant update (label, address, latitude, longitude) on public.parent_addresses to authenticated;

revoke execute on function public.parent_addresses_tidy(), public.parent_addresses_limit()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
