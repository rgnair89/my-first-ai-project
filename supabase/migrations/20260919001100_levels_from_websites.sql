-- supabase/migrations/20260919001100_levels_from_websites.sql
--
-- Levels (daycare, preschool, primary, secondary) from schools' own websites, checked by an admin, the same way as
-- boards. Many schools' names and Google types say nothing about their levels, so the app shows "Level not stated"
-- ("JBCN International School"). The read-school-websites function now also looks for levels ("Nursery to Grade 10",
-- "Primary section", "Classes I to X", Marathi "iyatta 5 vi te 10 vi"); an admin accepts them in the School Data
-- tab; accepted levels are ADDED to what the name and Google say. The app needs no change.
--
-- Run this BEFORE deploying the new read-school-websites. Safe to run more than once.
-- (Schools the reader read before this are read again after 30 days. To read them all again now:
--    update public.schools set last_site_check_at = null;   )

alter table public.school_site_findings add column if not exists levels jsonb not null default '[]'::jsonb;  -- [{ level, score, strong, evidence, url }]

alter table public.schools add column if not exists site_levels text[];
alter table public.schools add column if not exists site_levels_source_url text;
alter table public.schools add column if not exists site_levels_checked_at timestamptz;
alter table public.schools drop constraint if exists schools_site_levels_check;
alter table public.schools add constraint schools_site_levels_check
  check (site_levels is null or site_levels <@ array['daycare', 'preschool', 'primary', 'secondary']);

-- What the name and Google say (derive_levels), plus the levels an admin accepted from the school's website, in the
-- usual order. A school without website levels keeps exactly what it had (including NULL, "nothing known yet").
create or replace function public.combine_levels(p_derived text[], p_site text[])
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select case
    when p_site is null or cardinality(p_site) = 0 then p_derived
    else array(select o.l from unnest(array['daycare', 'preschool', 'primary', 'secondary']) with ordinality as o(l, n)
                where o.l = any (coalesce(p_derived, '{}') || p_site) order by o.n)
  end;
$$;

-- schools.levels is a generated column; it is made again to include the website levels (only if it does not already).
do $$
begin
  if coalesce((select pg_get_expr(d.adbin, d.adrelid)
                 from pg_attrdef d
                 join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                where d.adrelid = 'public.schools'::regclass and a.attname = 'levels'), '') not like '%combine_levels%' then
    alter table public.schools drop column if exists levels;
    alter table public.schools add column levels text[]
      generated always as (public.combine_levels(public.derive_levels(name, google_types), site_levels)) stored;
  end if;
end;
$$;
create index if not exists schools_levels_idx on public.schools using gin (levels);

-- record_site_finding and review_site_finding gain a levels argument (with a default, so the older function and
-- portal keep working until they are updated).
drop function if exists public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text);
create or replace function public.record_site_finding(p_school uuid, p_website text, p_pages jsonb, p_boards jsonb,
                                                      p_admission jsonb, p_error text default null, p_levels jsonb default null)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id uuid;
  v_boards jsonb := coalesce(p_boards, '[]'::jsonb);
  v_levels jsonb := coalesce(p_levels, '[]'::jsonb);
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
  if jsonb_typeof(v_levels) <> 'array' or jsonb_array_length(v_levels) > 4 then
    raise exception 'levels must be a list of at most 4';
  end if;
  if exists (select 1 from jsonb_array_elements(v_levels) l
             where jsonb_typeof(l) <> 'object' or not (l->>'level' = any (array['daycare', 'preschool', 'primary', 'secondary']))
                or char_length(coalesce(l->>'evidence', '')) > 400) then
    raise exception 'unknown level, or evidence too long';
  end if;
  if p_admission is not null and (jsonb_typeof(p_admission) <> 'object'
     or coalesce(p_admission->>'status', '') not in ('open', 'closed')
     or char_length(coalesce(p_admission->>'evidence', '')) > 400
     or (p_admission->>'year' is not null and p_admission->>'year' !~ '^20[0-9]{2}-[0-9]{2}$')) then
    raise exception 'admission must have status open or closed, a year like 2027-28, and short evidence';
  end if;

  v_has := jsonb_array_length(v_boards) > 0 or p_admission is not null or jsonb_array_length(v_levels) > 0;
  insert into public.school_site_findings (school_id, website, pages, boards, levels, admission, error, review_status)
    values (p_school, left(p_website, 500), coalesce(p_pages, '[]'::jsonb), v_boards, v_levels, p_admission, left(p_error, 500),
            case when v_has then 'pending' else 'no_findings' end)
    returning id into v_id;
  -- an older reading still waiting for review is replaced by this one
  update public.school_site_findings set review_status = 'superseded'
   where school_id = p_school and review_status = 'pending' and id <> v_id;
  update public.schools set last_site_check_at = now() where id = p_school;
  return v_id;
end;
$$;

-- An admin's decision on one finding. p_boards / p_levels: which of the boards / levels found to accept (empty =
-- none). p_use_admission: whether to accept the admission status found. Accepting nothing rejects the finding.
drop function if exists public.review_site_finding(uuid, text[], boolean, text);
create or replace function public.review_site_finding(p_finding uuid, p_boards text[], p_use_admission boolean,
                                                      p_note text default null, p_levels text[] default null)
 returns text
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  f public.school_site_findings;
  v_found text[];
  v_found_levels text[];
  v_boards text[] := coalesce(p_boards, '{}');
  v_levels text[] := coalesce(p_levels, '{}');
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
  select coalesce(array_agg(l->>'level'), '{}') into v_found_levels from jsonb_array_elements(f.levels) l;
  if not (v_levels <@ v_found_levels) then
    raise exception 'only levels found on the website can be accepted';
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

  if cardinality(v_levels) > 0 then
    select (array_agg(l->>'url' order by (l->>'score')::numeric desc nulls last))[1]
      into v_url
      from jsonb_array_elements(f.levels) l where l->>'level' = any (v_levels);
    update public.schools
       set site_levels = array(select o.l from unnest(array['daycare', 'preschool', 'primary', 'secondary']) with ordinality as o(l, n)
                                where o.l = any (v_levels) order by o.n),
           site_levels_source_url = coalesce(v_url, f.website),
           site_levels_checked_at = f.checked_at
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

  v_outcome := case when cardinality(v_boards) > 0 or cardinality(v_levels) > 0 or p_use_admission then 'accepted' else 'rejected' end;
  update public.school_site_findings
     set review_status = v_outcome, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 500)
   where id = p_finding;
  return v_outcome;
end;
$$;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named here as well as PUBLIC.
revoke execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb),
                          public.review_site_finding(uuid, text[], boolean, text, text[]),
                          public.combine_levels(text[], text[]) from public, anon;
grant execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb),
                         public.review_site_finding(uuid, text[], boolean, text, text[]) to authenticated;
grant execute on function public.combine_levels(text[], text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
