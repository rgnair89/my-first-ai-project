-- supabase/migrations/20260920000200_fees_and_start_times.sql
--
-- Fees, the true cost of a school, and when the school day starts.
--
-- 1. school_fee_schedules: one row per school and level (daycare, preschool, primary, secondary) with every fee a
--    family pays in rupees: tuition, transport, meals, uniform and books, activities, other yearly fees, and the
--    one-time admission and registration fees (a refundable deposit is shown but not counted as a cost).
--      annual_total      = everything paid every year
--      first_year_total  = the true cost of ownership for year one: every yearly fee plus the one-time fees
--    Kept by Kidscover admins and each school's own staff in the Partner Portal, like facilities: live at once,
--    every change logged, and a Kidscover admin can undo any change.
-- 2. schools gains a summary the parent app can filter and sort on: fee_daycare, fee_preschool, fee_primary,
--    fee_secondary (each level's first-year total), fees_from (the lowest of them) and fees_year. A trigger keeps them
--    in step with the schedules; nobody writes them directly.
-- 3. schools.start_time: when the school day starts (06:00 to 11:00), for "arrive by the start of school" drive times.
-- 4. school_tiles(): the numbers on the parent app's dashboard (schools near you, admissions open, admissions closed).
-- 5. schools_nearby returns the fee summary and start time too.
-- 6. The old school_fees table (from before the fee model; some of its numbers were invented by an old crawler) is
--    no longer readable by the apps. Nothing is deleted.
--
-- Needs 20260919001400 first. Safe to run more than once.

-- ---- the fee schedules ------------------------------------------------------------------------------------------------
create table if not exists public.school_fee_schedules (
  school_id uuid not null references public.schools (id) on delete cascade,
  level text not null check (level in ('daycare', 'preschool', 'primary', 'secondary')),
  academic_year text not null check (academic_year ~ '^20[0-9]{2}-[0-9]{2}$'),
  tuition integer not null check (tuition between 1 and 5000000),
  transport integer not null default 0 check (transport between 0 and 5000000),
  meals integer not null default 0 check (meals between 0 and 5000000),
  uniform_books integer not null default 0 check (uniform_books between 0 and 5000000),
  activities integer not null default 0 check (activities between 0 and 5000000),
  other_annual integer not null default 0 check (other_annual between 0 and 5000000),
  admission_fee integer not null default 0 check (admission_fee between 0 and 5000000),
  registration_fee integer not null default 0 check (registration_fee between 0 and 5000000),
  deposit integer not null default 0 check (deposit between 0 and 5000000),
  annual_total integer generated always as (tuition + transport + meals + uniform_books + activities + other_annual) stored,
  first_year_total integer generated always as
    (tuition + transport + meals + uniform_books + activities + other_annual + admission_fee + registration_fee) stored,
  note text check (note is null or char_length(note) between 1 and 200),
  source text not null check (source in ('school', 'school website', 'kidscover')),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (school_id, level)
);

-- ---- the summary on schools, kept in step by a trigger -----------------------------------------------------------------
alter table public.schools add column if not exists fee_daycare integer;
alter table public.schools add column if not exists fee_preschool integer;
alter table public.schools add column if not exists fee_primary integer;
alter table public.schools add column if not exists fee_secondary integer;
alter table public.schools add column if not exists fees_from integer;
alter table public.schools add column if not exists fees_year text;
create index if not exists schools_fees_from_idx on public.schools (fees_from);

create or replace function public.refresh_school_fee_summary()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_school uuid := case when tg_op = 'DELETE' then old.school_id else new.school_id end;
begin
  update public.schools s
     set fee_daycare = (select f.first_year_total from public.school_fee_schedules f where f.school_id = v_school and f.level = 'daycare'),
         fee_preschool = (select f.first_year_total from public.school_fee_schedules f where f.school_id = v_school and f.level = 'preschool'),
         fee_primary = (select f.first_year_total from public.school_fee_schedules f where f.school_id = v_school and f.level = 'primary'),
         fee_secondary = (select f.first_year_total from public.school_fee_schedules f where f.school_id = v_school and f.level = 'secondary'),
         fees_from = (select min(f.first_year_total) from public.school_fee_schedules f where f.school_id = v_school),
         fees_year = (select max(f.academic_year) from public.school_fee_schedules f where f.school_id = v_school)
   where s.id = v_school;
  return null;
end;
$$;
drop trigger if exists school_fee_schedules_summary on public.school_fee_schedules;
create trigger school_fee_schedules_summary after insert or update or delete on public.school_fee_schedules
  for each row execute function public.refresh_school_fee_summary();

-- ---- when the school day starts ---------------------------------------------------------------------------------------
alter table public.schools add column if not exists start_time time;
alter table public.schools add column if not exists start_time_source text;
alter table public.schools drop constraint if exists schools_start_time_check;
alter table public.schools add constraint schools_start_time_check check (
  (start_time is null and start_time_source is null)
  or (start_time is not null and start_time_source is not null
      and start_time between time '06:00' and time '11:00'
      and start_time_source in ('school', 'school website', 'kidscover'))
);

-- ---- the change log learns about fees and start times -------------------------------------------------------------------
alter table public.school_change_log drop constraint if exists school_change_log_what_check;
alter table public.school_change_log add constraint school_change_log_what_check
  check (what in ('facility', 'achievement', 'photo', 'staff', 'levels', 'fees', 'start_time'));

create or replace function public.log_school_change()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  r_new jsonb;
  r_old jsonb;
  v_school uuid;
  v_what text;
  v_key text;
  v_before jsonb;
  v_after jsonb;
begin
  if tg_op <> 'DELETE' then r_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then r_old := to_jsonb(old); end if;
  if tg_table_name = 'schools' and tg_argv[0] = 'levels' then
    v_school := (r_new->>'id')::uuid;
    v_what := 'levels';
    v_key := 'levels';
    if r_old->>'profile_levels' is not null then
      v_before := jsonb_build_object('levels', r_old->'profile_levels', 'source', r_old->'profile_levels_source');
    end if;
    if r_new->>'profile_levels' is not null then
      v_after := jsonb_build_object('levels', r_new->'profile_levels', 'source', r_new->'profile_levels_source');
    end if;
  elsif tg_table_name = 'schools' and tg_argv[0] = 'start_time' then
    v_school := (r_new->>'id')::uuid;
    v_what := 'start_time';
    v_key := 'start_time';
    if r_old->>'start_time' is not null then
      v_before := jsonb_build_object('time', r_old->'start_time', 'source', r_old->'start_time_source');
    end if;
    if r_new->>'start_time' is not null then
      v_after := jsonb_build_object('time', r_new->'start_time', 'source', r_new->'start_time_source');
    end if;
  elsif tg_table_name = 'schools' then
    v_school := (r_new->>'id')::uuid;
    v_what := 'photo';
    v_key := 'photo';
    if r_old->>'photo_url' is not null then
      v_before := jsonb_build_object('url', r_old->'photo_url', 'source', r_old->'photo_source', 'credit', r_old->'photo_credit',
                                     'licence', r_old->'photo_licence', 'page_url', r_old->'photo_page_url');
    end if;
    if r_new->>'photo_url' is not null then
      v_after := jsonb_build_object('url', r_new->'photo_url', 'source', r_new->'photo_source', 'credit', r_new->'photo_credit',
                                    'licence', r_new->'photo_licence', 'page_url', r_new->'photo_page_url');
    end if;
  else
    v_school := coalesce(r_new->>'school_id', r_old->>'school_id')::uuid;
    if tg_table_name = 'school_facilities' then
      v_what := 'facility';
      v_key := coalesce(r_new->>'facility', r_old->>'facility');
    elsif tg_table_name = 'school_achievements' then
      v_what := 'achievement';
      v_key := coalesce(r_new->>'id', r_old->>'id');
    elsif tg_table_name = 'school_fee_schedules' then
      v_what := 'fees';
      v_key := coalesce(r_new->>'level', r_old->>'level');
    else
      v_what := 'staff';
      v_key := coalesce(r_new->>'user_id', r_old->>'user_id');
    end if;
    v_before := r_old - 'school_id' - 'updated_by' - 'updated_at' - 'added_by' - 'added_at' - 'annual_total' - 'first_year_total';
    v_after := r_new - 'school_id' - 'updated_by' - 'updated_at' - 'added_by' - 'added_at' - 'annual_total' - 'first_year_total';
  end if;
  -- nothing that matters changed, or the school itself is being deleted (its rows go with it)
  if v_before is not distinct from v_after or not exists (select 1 from public.schools where id = v_school) then
    return null;
  end if;
  insert into public.school_change_log (school_id, what, record_key, action, before, after, changed_by, changed_by_role, reverts)
  values (v_school, v_what, v_key,
          case when v_before is null then 'added' when v_after is null then 'removed' else 'changed' end,
          v_before, v_after, auth.uid(),
          (select p.role from public.profiles p where p.id = auth.uid()),
          nullif(current_setting('kidscover.reverting', true), '')::bigint);
  return null;
end;
$$;

drop trigger if exists school_fee_schedules_log on public.school_fee_schedules;
create trigger school_fee_schedules_log after insert or update or delete on public.school_fee_schedules
  for each row execute function public.log_school_change();
drop trigger if exists schools_start_time_log on public.schools;
create trigger schools_start_time_log after update of start_time, start_time_source on public.schools
  for each row execute function public.log_school_change('start_time');

-- ---- writing, for Kidscover admins and the school's own staff ------------------------------------------------------------
-- p_fees null removes the level's fees. Otherwise a json object; amounts are whole rupees (missing ones count as 0):
--   { "academic_year": "2026-27", "tuition": 150000, "transport": 30000, "meals": 0, "uniform_books": 8000,
--     "activities": 5000, "other_annual": 0, "admission_fee": 25000, "registration_fee": 1000, "deposit": 10000,
--     "note": "optional, 200 characters", "source_url": "optional https link to the fee page" }
create or replace function public.set_school_fees(p_school uuid, p_level text, p_fees jsonb)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_keys text[] := array['tuition', 'transport', 'meals', 'uniform_books', 'activities', 'other_annual',
                         'admission_fee', 'registration_fee', 'deposit'];
  v_amount jsonb;
  k text;
  v_year text;
  v_start int;
  v_note text;
  v_url text;
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if p_level is null or p_level not in ('daycare', 'preschool', 'primary', 'secondary') then
    raise exception 'Choose the level these fees are for' using errcode = '22023';
  end if;
  if not exists (select 1 from public.schools where id = p_school) then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
  if p_fees is null or jsonb_typeof(p_fees) = 'null' then
    delete from public.school_fee_schedules where school_id = p_school and level = p_level;
    return;
  end if;
  if jsonb_typeof(p_fees) <> 'object' then
    raise exception 'The fees must be a list of amounts' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_fees) j
              where j not in ('academic_year', 'note', 'source_url', 'tuition', 'transport', 'meals', 'uniform_books',
                              'activities', 'other_annual', 'admission_fee', 'registration_fee', 'deposit')) then
    raise exception 'Unknown fee field' using errcode = '22023';
  end if;
  foreach k in array v_keys loop
    v_amount := p_fees->k;
    if v_amount is not null and jsonb_typeof(v_amount) <> 'null'
       and (jsonb_typeof(v_amount) <> 'number' or (v_amount #>> '{}') !~ '^[0-9]{1,7}$' or (v_amount #>> '{}')::int > 5000000) then
      raise exception 'Fees are whole rupees from 0 to 50,00,000 (check %)', k using errcode = '22023';
    end if;
  end loop;
  if coalesce((p_fees->>'tuition')::int, 0) < 1 then
    raise exception 'Give the yearly tuition fee' using errcode = '22023';
  end if;
  v_year := p_fees->>'academic_year';
  if v_year is null or v_year !~ '^20[0-9]{2}-[0-9]{2}$' then
    raise exception 'Give the academic year like 2026-27' using errcode = '22023';
  end if;
  v_start := left(v_year, 4)::int;
  if right(v_year, 2)::int <> (v_start + 1) % 100
     or v_start not between extract(year from now())::int - 1 and extract(year from now())::int + 2 then
    raise exception 'Give the academic year like 2026-27 (last year, this year or the next two)' using errcode = '22023';
  end if;
  v_note := nullif(btrim(coalesce(p_fees->>'note', '')), '');
  if char_length(v_note) > 200 then
    raise exception 'Keep the note under 200 characters' using errcode = '22023';
  end if;
  v_url := nullif(btrim(coalesce(p_fees->>'source_url', '')), '');
  if v_url is not null and (v_url !~* '^https?://[^\s/]+\.[^\s]+$' or char_length(v_url) > 500) then
    raise exception 'The link must start with http:// or https://' using errcode = '22023';
  end if;
  insert into public.school_fee_schedules as f (school_id, level, academic_year, tuition, transport, meals, uniform_books,
                                                activities, other_annual, admission_fee, registration_fee, deposit, note,
                                                source, source_url, updated_by, updated_at)
  values (p_school, p_level, v_year,
          (p_fees->>'tuition')::int, coalesce((p_fees->>'transport')::int, 0), coalesce((p_fees->>'meals')::int, 0),
          coalesce((p_fees->>'uniform_books')::int, 0), coalesce((p_fees->>'activities')::int, 0),
          coalesce((p_fees->>'other_annual')::int, 0), coalesce((p_fees->>'admission_fee')::int, 0),
          coalesce((p_fees->>'registration_fee')::int, 0), coalesce((p_fees->>'deposit')::int, 0),
          v_note, public.editor_source(), v_url, auth.uid(), now())
  on conflict (school_id, level) do update
    set academic_year = excluded.academic_year, tuition = excluded.tuition, transport = excluded.transport,
        meals = excluded.meals, uniform_books = excluded.uniform_books, activities = excluded.activities,
        other_annual = excluded.other_annual, admission_fee = excluded.admission_fee,
        registration_fee = excluded.registration_fee, deposit = excluded.deposit, note = excluded.note,
        source = excluded.source, source_url = excluded.source_url, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- p_time 'HH:MM' (06:00 to 11:00), or null when the start time is not known.
create or replace function public.set_school_start_time(p_school uuid, p_time text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_time time;
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if p_time is not null then
    if btrim(p_time) !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Give the start time like 08:15' using errcode = '22023';
    end if;
    v_time := btrim(p_time)::time;
    if v_time not between time '06:00' and time '11:00' then
      raise exception 'The school day should start between 06:00 and 11:00' using errcode = '22023';
    end if;
  end if;
  update public.schools
     set start_time = v_time,
         start_time_source = case when v_time is null then null else public.editor_source() end
   where id = p_school;
  if not found then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
end;
$$;

-- ---- undo, now for fees and start times as well ------------------------------------------------------------------------
create or replace function public.revert_school_change(p_log bigint)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  c public.school_change_log;
  b jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can undo changes' using errcode = '42501';
  end if;
  select * into c from public.school_change_log where id = p_log for update;
  if not found then
    raise exception 'No such change' using errcode = 'P0002';
  end if;
  if c.reverted_at is not null then
    raise exception 'That change was already undone' using errcode = '22023';
  end if;
  if c.what = 'staff' then
    raise exception 'Staff changes are undone by adding or removing the person again' using errcode = '22023';
  end if;
  if exists (select 1 from public.school_change_log l
              where l.school_id = c.school_id and l.what = c.what and l.record_key = c.record_key and l.id > c.id) then
    raise exception 'This was changed again later; undo the later change first' using errcode = '22023';
  end if;
  b := c.before;
  perform set_config('kidscover.reverting', c.id::text, true);
  if c.what = 'facility' then
    if b is null then
      delete from public.school_facilities where school_id = c.school_id and facility = c.record_key;
    else
      insert into public.school_facilities (school_id, facility, detail, source, source_url, updated_by, updated_at)
      values (c.school_id, c.record_key, b->>'detail', b->>'source', b->>'source_url', auth.uid(), now())
      on conflict (school_id, facility) do update
        set detail = excluded.detail, source = excluded.source, source_url = excluded.source_url, updated_by = auth.uid(), updated_at = now();
    end if;
  elsif c.what = 'achievement' then
    if b is null then
      delete from public.school_achievements where id = c.record_key::uuid;
    else
      insert into public.school_achievements (id, school_id, kind, text, year, source, source_url, updated_by, updated_at)
      values (c.record_key::uuid, c.school_id, b->>'kind', b->>'text', (b->>'year')::int, b->>'source', b->>'source_url', auth.uid(), now())
      on conflict (id) do update
        set kind = excluded.kind, text = excluded.text, year = excluded.year, source = excluded.source,
            source_url = excluded.source_url, updated_by = auth.uid(), updated_at = now();
    end if;
  elsif c.what = 'levels' then
    update public.schools
       set profile_levels = case when b is null then null else array(select jsonb_array_elements_text(b->'levels')) end,
           profile_levels_source = b->>'source'
     where id = c.school_id;
  elsif c.what = 'fees' then
    if b is null then
      delete from public.school_fee_schedules where school_id = c.school_id and level = c.record_key;
    else
      insert into public.school_fee_schedules (school_id, level, academic_year, tuition, transport, meals, uniform_books,
                                               activities, other_annual, admission_fee, registration_fee, deposit, note,
                                               source, source_url, updated_by, updated_at)
      values (c.school_id, c.record_key, b->>'academic_year', (b->>'tuition')::int, (b->>'transport')::int, (b->>'meals')::int,
              (b->>'uniform_books')::int, (b->>'activities')::int, (b->>'other_annual')::int, (b->>'admission_fee')::int,
              (b->>'registration_fee')::int, (b->>'deposit')::int, b->>'note', b->>'source', b->>'source_url', auth.uid(), now())
      on conflict (school_id, level) do update
        set academic_year = excluded.academic_year, tuition = excluded.tuition, transport = excluded.transport,
            meals = excluded.meals, uniform_books = excluded.uniform_books, activities = excluded.activities,
            other_annual = excluded.other_annual, admission_fee = excluded.admission_fee,
            registration_fee = excluded.registration_fee, deposit = excluded.deposit, note = excluded.note,
            source = excluded.source, source_url = excluded.source_url, updated_by = auth.uid(), updated_at = now();
    end if;
  elsif c.what = 'start_time' then
    update public.schools
       set start_time = (b->>'time')::time, start_time_source = b->>'source'
     where id = c.school_id;
  else
    update public.schools
       set photo_url = b->>'url', photo_source = b->>'source', photo_credit = b->>'credit', photo_licence = b->>'licence',
           photo_page_url = b->>'page_url', photo_updated_at = now()
     where id = c.school_id;
  end if;
  perform set_config('kidscover.reverting', '', true);
  update public.school_change_log set reverted_by = auth.uid(), reverted_at = now() where id = c.id;
end;
$$;

-- ---- the dashboard tiles -----------------------------------------------------------------------------------------------
-- Counts of schools (the main list: category 'school', not hidden) for the parent app's dashboard. With a position and a
-- distance (1 to 50 km), only schools that close. Admission counts include only statuses with a source, as the app shows.
-- Runs as the caller, so the database's own rules about hidden places apply.
create or replace function public.school_tiles(p_lat double precision default null, p_lng double precision default null,
                                               p_km double precision default null)
 returns jsonb
 language sql
 stable
 security invoker
 set search_path = ''
as $$
  select jsonb_build_object(
    'schools', count(*)::int,
    'admissions_open', (count(*) filter (where s.admissions_source_url is not null and s.admissions_open is true))::int,
    'admissions_closed', (count(*) filter (where s.admissions_source_url is not null and s.admissions_open is false))::int,
    'with_fees', (count(*) filter (where s.fees_from is not null))::int)
  from public.schools s
  where s.is_hidden = false
    and s.category = 'school'
    and (p_lat is null or p_lng is null or p_km is null
         or (p_lat between -90 and 90 and p_lng between -180 and 180 and p_km between 1 and 50
             and s.latitude between -90 and 90 and s.longitude between -180 and 180
             and not (s.latitude = 0 and s.longitude = 0)
             and 2 * 6371.0088 * asin(least(1.0, sqrt(
                   power(sin(radians(s.latitude::double precision - p_lat) / 2), 2)
                   + cos(radians(p_lat)) * cos(radians(s.latitude::double precision))
                     * power(sin(radians(s.longitude::double precision - p_lng) / 2), 2)))) <= p_km));
$$;

-- ---- schools_nearby, with the fee summary and start time ---------------------------------------------------------------
drop function if exists public.schools_nearby(double precision, double precision);
drop type if exists public.school_with_distance;

create type public.school_with_distance as (
  id uuid,
  name text,
  name_sort text collate "C",
  address text,
  website text,
  board text,
  levels text[],
  google_rating numeric,
  google_review_count integer,
  is_hidden boolean,
  category text,
  boards text[],
  board_source text,
  board_source_url text,
  admissions_open boolean,
  admissions_year text,
  admissions_source_url text,
  admissions_checked_at timestamptz,
  photo_url text,
  photo_source text,
  photo_credit text,
  photo_licence text,
  photo_page_url text,
  fee_daycare integer,
  fee_preschool integer,
  fee_primary integer,
  fee_secondary integer,
  fees_from integer,
  fees_year text,
  start_time time,
  start_time_source text,
  distance_km double precision
);

create function public.schools_nearby(p_lat double precision, p_lng double precision)
 returns setof public.school_with_distance
 language sql
 stable
 security invoker
 set search_path = ''
as $$
  select q.id, q.name, q.name_sort, q.address, q.website, q.board, q.levels,
         q.google_rating, q.google_review_count, q.is_hidden, q.category,
         q.boards, q.board_source, q.board_source_url, q.admissions_open, q.admissions_year, q.admissions_source_url,
         q.admissions_checked_at, q.photo_url, q.photo_source, q.photo_credit, q.photo_licence, q.photo_page_url,
         q.fee_daycare, q.fee_preschool, q.fee_primary, q.fee_secondary, q.fees_from, q.fees_year,
         q.start_time, q.start_time_source, q.distance_km
  from (
    select s.id, s.name, s.name_sort, s.address, s.website, s.board, s.levels,
           s.google_rating, s.google_review_count, s.is_hidden, s.category,
           s.boards, s.board_source, s.board_source_url, s.admissions_open, s.admissions_year, s.admissions_source_url,
           s.admissions_checked_at, s.photo_url, s.photo_source, s.photo_credit, s.photo_licence, s.photo_page_url,
           s.fee_daycare, s.fee_preschool, s.fee_primary, s.fee_secondary, s.fees_from, s.fees_year,
           s.start_time, s.start_time_source,
           round((
             2 * 6371.0088 * asin(least(1.0, sqrt(
               power(sin(radians(s.latitude::double precision - p_lat) / 2), 2)
               + cos(radians(p_lat)) * cos(radians(s.latitude::double precision))
                 * power(sin(radians(s.longitude::double precision - p_lng) / 2), 2)
             )))
           )::numeric, 2)::double precision as distance_km
    from public.schools s
    where p_lat between -90 and 90
      and p_lng between -180 and 180
      and s.latitude between -90 and 90
      and s.longitude between -180 and 180
      and not (s.latitude = 0 and s.longitude = 0)
  ) q;
$$;

-- ---- who can read and call what -----------------------------------------------------------------------------------------
alter table public.school_fee_schedules enable row level security;
drop policy if exists "Fees of visible schools are public" on public.school_fee_schedules;
create policy "Fees of visible schools are public" on public.school_fee_schedules
  for select using (exists (select 1 from public.schools s where s.id = school_id));
revoke all on public.school_fee_schedules from anon, authenticated;
grant select on public.school_fee_schedules to anon, authenticated;

-- the old fee table: no longer read by either app, and some of its numbers were made up
drop policy if exists "Allow public read on school_fees" on public.school_fees;
drop policy if exists "Public fees are viewable by everyone." on public.school_fees;
revoke all on public.school_fees from anon, authenticated;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named as well as PUBLIC.
revoke execute on function public.set_school_fees(uuid, text, jsonb), public.set_school_start_time(uuid, text),
  public.refresh_school_fee_summary(), public.school_tiles(double precision, double precision, double precision)
  from public, anon;
grant execute on function public.set_school_fees(uuid, text, jsonb), public.set_school_start_time(uuid, text) to authenticated;
grant execute on function public.school_tiles(double precision, double precision, double precision) to anon, authenticated;
revoke all on function public.schools_nearby(double precision, double precision) from public;
grant execute on function public.schools_nearby(double precision, double precision) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
