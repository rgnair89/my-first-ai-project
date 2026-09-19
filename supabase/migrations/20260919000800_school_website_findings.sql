-- Boards and admission status, read from each school's own website and checked by an admin. Safe to run more than once.
--
-- Where the facts come from, and why:
--   * The school's own website. Schools say which board they follow ("affiliated to CBSE, affiliation no. 1130xxx",
--     "an ICSE school", "IB World School", "SSC board") and whether admissions are open ("Admissions open 2027-28").
--   * For CBSE, the affiliation number a school gives is looked up on CBSE's own public record for that number
--     (saras.cbse.gov.in/.../AfflicationDetails/<number>), which states the school's name, district, PIN code and
--     website. When they match, the finding is marked as confirmed by CBSE.
--   * Not used: the CBSE and CISCE search pages refuse automated requests (CBSE's district list answers 403, CISCE uses
--     reCAPTCHA), and the open UDISE+ extracts carry no board column. Those refusals are respected, not worked around.
-- The read-school-websites edge function stores what it found in school_site_findings. NOTHING reaches the app until an
-- admin accepts it in the Partner Portal, and every accepted fact keeps its source link.
--
-- Board names used everywhere: CBSE, ICSE (the CISCE council, including ISC), IB, IGCSE (Cambridge), State Board, NIOS.

-- ---- what the app can show about a school ----------------------------------------------------------------------------
alter table public.schools
  add column if not exists boards text[],
  add column if not exists board_source text,
  add column if not exists board_source_url text,
  add column if not exists board_checked_at timestamptz,
  add column if not exists admissions_year text,
  add column if not exists admissions_source_url text,
  add column if not exists admissions_checked_at timestamptz,
  add column if not exists last_site_check_at timestamptz;

-- "Admissions open" was false by default, which claims every new school is closed. Unknown is the honest default.
-- Every school imported since the cleanup of 18 September got that false without anyone saying so, so any admission
-- status that has no source is put back to unknown. (Accepted ones keep their source link, so a re-run leaves them.)
alter table public.schools alter column admissions_open drop default;
update public.schools set admissions_open = null where admissions_source_url is null and admissions_open is not null;

create or replace function public.valid_boards(p text[])
 returns boolean
 language sql
 immutable
 set search_path = ''
as $$
  select p is null or (cardinality(p) between 1 and 6
    and p <@ array['CBSE', 'ICSE', 'IB', 'IGCSE', 'State Board', 'NIOS']::text[]);
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.schools'::regclass and conname = 'schools_boards_valid') then
    alter table public.schools add constraint schools_boards_valid check (public.valid_boards(boards));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.schools'::regclass and conname = 'schools_board_source_valid') then
    alter table public.schools add constraint schools_board_source_valid
      check (board_source is null or board_source in ('school name', 'school website', 'CBSE directory', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.schools'::regclass and conname = 'schools_admissions_year_valid') then
    alter table public.schools add constraint schools_admissions_year_valid
      check (admissions_year is null or admissions_year ~ '^20[0-9]{2}-[0-9]{2}$');
  end if;
end $$;

create index if not exists schools_boards_idx on public.schools using gin (boards);
create index if not exists schools_site_check_idx on public.schools (last_site_check_at nulls first);

-- The importer still sets board from a school's own name ("... CBSE School"). Keep boards in step with that, so the
-- board filter sees those schools too. An admin-accepted list is never overwritten this way.
create or replace function public.schools_board_from_name()
 returns trigger
 language plpgsql
 set search_path = ''
as $$
begin
  if new.boards is null and new.board in ('CBSE', 'ICSE', 'IB', 'IGCSE', 'State Board', 'NIOS') then
    new.boards := array[new.board];
    new.board_source := coalesce(new.board_source, 'school name');
  end if;
  return new;
end;
$$;
drop trigger if exists schools_board_from_name on public.schools;
create trigger schools_board_from_name before insert or update of board, boards on public.schools
  for each row execute function public.schools_board_from_name();

update public.schools set boards = array[board], board_source = coalesce(board_source, 'school name')
 where boards is null and board in ('CBSE', 'ICSE', 'IB', 'IGCSE', 'State Board', 'NIOS');

-- ---- schools near me carries the new facts too ------------------------------------------------------------------------
-- The same function as in 20260919000500_schools_nearby.sql, with the board and admission columns added so the app's
-- board filter and admission line also work in "near me" lists. The distance maths is unchanged.
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
  boards text[],
  board_source text,
  board_source_url text,
  admissions_open boolean,
  admissions_year text,
  admissions_source_url text,
  admissions_checked_at timestamptz,
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
         q.google_rating, q.google_review_count, q.is_hidden,
         q.boards, q.board_source, q.board_source_url, q.admissions_open, q.admissions_year, q.admissions_source_url,
         q.admissions_checked_at, q.distance_km
  from (
    select s.id, s.name, s.name_sort, s.address, s.website, s.board, s.levels,
           s.google_rating, s.google_review_count, s.is_hidden,
           s.boards, s.board_source, s.board_source_url, s.admissions_open, s.admissions_year, s.admissions_source_url,
           s.admissions_checked_at,
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

revoke all on function public.schools_nearby(double precision, double precision) from public;
grant execute on function public.schools_nearby(double precision, double precision) to anon, authenticated, service_role;

-- ---- what the website reader found, waiting for an admin -------------------------------------------------------------
create table if not exists public.school_site_findings (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  checked_at timestamptz not null default now(),
  website text,
  pages jsonb not null default '[]'::jsonb,     -- [{ url, status, note }]
  boards jsonb not null default '[]'::jsonb,    -- [{ board, score, strong, evidence, url, affiliationNo, verified }]
  admission jsonb,                              -- { status: open | closed, year, evidence, url, stale } or null
  error text,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'accepted', 'rejected', 'no_findings', 'superseded')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500)
);
create index if not exists school_site_findings_review_idx on public.school_site_findings (review_status, checked_at desc);
create index if not exists school_site_findings_school_idx on public.school_site_findings (school_id, checked_at desc);

-- Stores one reading of a school's website. Admins only (the edge function runs as the admin who pressed the button).
create or replace function public.record_site_finding(p_school uuid, p_website text, p_pages jsonb, p_boards jsonb,
                                                      p_admission jsonb, p_error text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id uuid;
  v_boards jsonb := coalesce(p_boards, '[]'::jsonb);
  v_has boolean;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools where id = p_school) then
    raise exception 'school not found';
  end if;
  if jsonb_typeof(v_boards) <> 'array' or jsonb_array_length(v_boards) > 6 then
    raise exception 'boards must be a list of at most 6';
  end if;
  if exists (select 1 from jsonb_array_elements(v_boards) b
             where not (b ? 'board') or not (b->>'board' = any (array['CBSE', 'ICSE', 'IB', 'IGCSE', 'State Board', 'NIOS']))
                or char_length(coalesce(b->>'evidence', '')) > 400) then
    raise exception 'unknown board, or evidence too long';
  end if;
  if p_admission is not null and (jsonb_typeof(p_admission) <> 'object'
     or coalesce(p_admission->>'status', '') not in ('open', 'closed')
     or char_length(coalesce(p_admission->>'evidence', '')) > 400
     or (p_admission->>'year' is not null and p_admission->>'year' !~ '^20[0-9]{2}-[0-9]{2}$')) then
    raise exception 'admission must have status open or closed, a year like 2027-28, and short evidence';
  end if;

  v_has := jsonb_array_length(v_boards) > 0 or p_admission is not null;
  insert into public.school_site_findings (school_id, website, pages, boards, admission, error, review_status)
    values (p_school, left(p_website, 500), coalesce(p_pages, '[]'::jsonb), v_boards, p_admission, left(p_error, 500),
            case when v_has then 'pending' else 'no_findings' end)
    returning id into v_id;
  -- an older reading still waiting for review is replaced by this one
  update public.school_site_findings set review_status = 'superseded'
   where school_id = p_school and review_status = 'pending' and id <> v_id;
  update public.schools set last_site_check_at = now() where id = p_school;
  return v_id;
end;
$$;

-- An admin's decision on one finding. p_boards: which of the found boards to accept (empty = none).
-- p_use_admission: whether to accept the admission status found. Accepting neither rejects the finding.
create or replace function public.review_site_finding(p_finding uuid, p_boards text[], p_use_admission boolean,
                                                      p_note text default null)
 returns text
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  f public.school_site_findings;
  v_found text[];
  v_boards text[] := coalesce(p_boards, '{}');
  v_verified boolean;
  v_url text;
  v_outcome text;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select * into f from public.school_site_findings where id = p_finding for update;
  if not found then
    raise exception 'finding not found';
  end if;
  if f.review_status <> 'pending' then
    raise exception 'this finding was already dealt with (%)', f.review_status;
  end if;
  select coalesce(array_agg(b->>'board'), '{}') into v_found from jsonb_array_elements(f.boards) b;
  if not (v_boards <@ v_found) then
    raise exception 'only boards found on the website can be accepted';
  end if;

  if cardinality(v_boards) > 0 then
    select bool_or(coalesce((b->'verified'->>'confirmed')::boolean, false)),
           (array_agg(b->>'url' order by (b->>'score')::numeric desc nulls last))[1]
      into v_verified, v_url
      from jsonb_array_elements(f.boards) b where b->>'board' = any (v_boards);
    update public.schools
       set boards = (select array_agg(x order by x) from unnest(v_boards) x),
           board = (select string_agg(x, ' / ' order by x) from unnest(v_boards) x),
           board_source = case when v_verified then 'CBSE directory' else 'school website' end,
           board_source_url = coalesce(v_url, f.website),
           board_checked_at = f.checked_at
     where id = f.school_id;
  end if;

  if p_use_admission then
    if f.admission is null then
      raise exception 'no admission status was found to accept';
    end if;
    if coalesce((f.admission->>'stale')::boolean, false) then
      raise exception 'that admission notice is for a past year';
    end if;
    update public.schools
       set admissions_open = (f.admission->>'status' = 'open'),
           admissions_year = f.admission->>'year',
           admissions_source_url = coalesce(f.admission->>'url', f.website),
           admissions_checked_at = f.checked_at
     where id = f.school_id;
  end if;

  v_outcome := case when cardinality(v_boards) > 0 or p_use_admission then 'accepted' else 'rejected' end;
  update public.school_site_findings
     set review_status = v_outcome, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 500)
   where id = p_finding;
  return v_outcome;
end;
$$;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named here as well as PUBLIC.
revoke execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text),
                          public.review_site_finding(uuid, text[], boolean, text) from public, anon;
grant execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text),
                         public.review_site_finding(uuid, text[], boolean, text) to authenticated;

alter table public.school_site_findings enable row level security;
drop policy if exists "Admins read website findings" on public.school_site_findings;
create policy "Admins read website findings" on public.school_site_findings
  for select to authenticated using (public.is_admin());
revoke all on public.school_site_findings from anon, authenticated;
grant select on public.school_site_findings to authenticated;

notify pgrst, 'reload schema';
