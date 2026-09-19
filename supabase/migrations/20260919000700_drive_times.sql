-- Drive times by car: how many Google lookups a parent may make, and a daily budget for the whole app.
-- Safe to run more than once.
--
-- The parent app asks the commute-times edge function for the drive time from where the parent is to the schools on
-- the screen (at most 20 at a time). The function calls Google's Routes API, which charges per school looked up
-- ("element"). This file is the brake on that bill:
--   * each signed-in parent with a confirmed email gets a number of lookups a day (default 20);
--   * the whole app gets a number of elements a day (default 500 = 25 full screens), after which drive times pause
--     until midnight (India time);
--   * one switch turns the feature off completely.
-- Change the numbers with one line, for example:
--   update public.commute_settings set per_user_daily_lookups = 30, global_daily_elements = 1000;
-- See today's use:
--   select * from public.commute_usage_daily order by day desc limit 7;
--
-- What is stored: a count per parent per day, and a total per day. NOT where anyone was: the parent's position goes to
-- Google for that one calculation and is never written to this database.

create table if not exists public.commute_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default true,
  per_user_daily_lookups integer not null default 20 check (per_user_daily_lookups between 0 and 1000),
  global_daily_elements integer not null default 500 check (global_daily_elements between 0 and 100000),
  max_schools_per_lookup integer not null default 20 check (max_schools_per_lookup between 1 and 25),
  updated_at timestamptz not null default now()
);
insert into public.commute_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.commute_usage (
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  lookups integer not null default 0,
  elements integer not null default 0,
  primary key (day, user_id)
);

create table if not exists public.commute_usage_daily (
  day date primary key,
  lookups integer not null default 0,
  elements integer not null default 0
);

-- Takes one lookup of p_elements schools from today's allowance, or says why not. The edge function calls it as the
-- parent (so auth.uid() is the parent) BEFORE it calls Google. Row locks make two lookups at the same moment queue up
-- instead of both slipping under a limit.
create or replace function public.take_commute_quota(p_elements integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_set public.commute_settings;
  v_user_lookups integer;
  v_global_elements integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'sign_in');
  end if;
  select * into v_set from public.commute_settings where id = 1;
  if not found or not v_set.enabled then
    return jsonb_build_object('ok', false, 'reason', 'switched_off');
  end if;
  if not public.is_verified_user() then
    return jsonb_build_object('ok', false, 'reason', 'confirm_email');
  end if;
  if p_elements is null or p_elements < 1 or p_elements > v_set.max_schools_per_lookup then
    return jsonb_build_object('ok', false, 'reason', 'too_many_schools', 'max', v_set.max_schools_per_lookup);
  end if;

  insert into public.commute_usage_daily (day) values (v_day) on conflict (day) do nothing;
  select elements into v_global_elements from public.commute_usage_daily where day = v_day for update;
  insert into public.commute_usage (day, user_id) values (v_day, v_uid) on conflict (day, user_id) do nothing;
  select lookups into v_user_lookups from public.commute_usage where day = v_day and user_id = v_uid for update;

  if v_user_lookups >= v_set.per_user_daily_lookups then
    return jsonb_build_object('ok', false, 'reason', 'user_limit', 'limit', v_set.per_user_daily_lookups);
  end if;
  if v_global_elements + p_elements > v_set.global_daily_elements then
    return jsonb_build_object('ok', false, 'reason', 'daily_budget');
  end if;

  update public.commute_usage set lookups = lookups + 1, elements = elements + p_elements
   where day = v_day and user_id = v_uid;
  update public.commute_usage_daily set lookups = lookups + 1, elements = elements + p_elements
   where day = v_day;
  return jsonb_build_object('ok', true, 'lookups_left', v_set.per_user_daily_lookups - v_user_lookups - 1);
end;
$$;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named here as well as PUBLIC.
revoke execute on function public.take_commute_quota(integer) from public, anon;
grant execute on function public.take_commute_quota(integer) to authenticated;

-- ---- row level security: the counters are written only by the function above ----
alter table public.commute_settings enable row level security;
alter table public.commute_usage enable row level security;
alter table public.commute_usage_daily enable row level security;

drop policy if exists "Admins read drive-time settings" on public.commute_settings;
drop policy if exists "Admins change drive-time settings" on public.commute_settings;
drop policy if exists "Admins read drive-time use" on public.commute_usage;
drop policy if exists "Parents read their own drive-time use" on public.commute_usage;
drop policy if exists "Admins read the daily drive-time total" on public.commute_usage_daily;
create policy "Admins read drive-time settings" on public.commute_settings
  for select to authenticated using (public.is_admin());
create policy "Admins change drive-time settings" on public.commute_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins read drive-time use" on public.commute_usage
  for select to authenticated using (public.is_admin());
create policy "Parents read their own drive-time use" on public.commute_usage
  for select to authenticated using (user_id = auth.uid());
create policy "Admins read the daily drive-time total" on public.commute_usage_daily
  for select to authenticated using (public.is_admin());

revoke all on public.commute_settings, public.commute_usage, public.commute_usage_daily from anon, authenticated;
grant select on public.commute_settings, public.commute_usage, public.commute_usage_daily to authenticated;
grant update (enabled, per_user_daily_lookups, global_daily_elements, max_schools_per_lookup) on public.commute_settings to authenticated;

notify pgrst, 'reload schema';
