-- supabase/migrations/20260919001300_facilities_achievements_from_websites.sql
--
-- The website reader also finds facilities (library, labs, pool, school bus, teacher-student ratio ...) and publicly
-- claimed achievements (class 10 / 12 results, placements, alumni, awards) on a school's own website. They wait in the
-- School Data tab like boards and levels; what an admin accepts is written to the school's profile
-- (school_facilities / school_achievements from 20260919001200), marked "from the school's website" with the page it
-- came from, and logged like every other change.
--
-- What the school itself (or Kidscover) entered is never overwritten by a website finding: a facility the school
-- already listed keeps its own detail, and an achievement already there with the same text is not added twice.
--
-- Needs 20260919001100 (levels) and 20260919001200 (school profiles) first. Run it BEFORE deploying the new
-- read-school-websites. Safe to run more than once.

alter table public.school_site_findings add column if not exists facilities jsonb not null default '[]'::jsonb;   -- [{ facility, detail, score, strong, evidence, url }]
alter table public.school_site_findings add column if not exists achievements jsonb not null default '[]'::jsonb; -- [{ kind, text, year, evidence, url }]

drop function if exists public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb);
create or replace function public.record_site_finding(p_school uuid, p_website text, p_pages jsonb, p_boards jsonb,
                                                      p_admission jsonb, p_error text default null, p_levels jsonb default null,
                                                      p_facilities jsonb default null, p_achievements jsonb default null)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id uuid;
  v_boards jsonb := coalesce(p_boards, '[]'::jsonb);
  v_levels jsonb := coalesce(p_levels, '[]'::jsonb);
  v_facilities jsonb := coalesce(p_facilities, '[]'::jsonb);
  v_achievements jsonb := coalesce(p_achievements, '[]'::jsonb);
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
  if jsonb_typeof(v_facilities) <> 'array' or jsonb_array_length(v_facilities) > 20 then
    raise exception 'facilities must be a list of at most 20';
  end if;
  if exists (select 1 from jsonb_array_elements(v_facilities) f
             where jsonb_typeof(f) <> 'object' or not (f->>'facility' = any (public.facility_keys()))
                or char_length(coalesce(f->>'detail', '')) > 120 or char_length(coalesce(f->>'evidence', '')) > 400
                or (f->>'facility' = 'teacher_ratio' and coalesce(f->>'detail', '') !~ '^1:[0-9]{1,3}$')) then
    raise exception 'unknown facility, or its detail or evidence is not right';
  end if;
  if jsonb_typeof(v_achievements) <> 'array' or jsonb_array_length(v_achievements) > 12 then
    raise exception 'achievements must be a list of at most 12';
  end if;
  if exists (select 1 from jsonb_array_elements(v_achievements) a
             where jsonb_typeof(a) <> 'object' or not (a->>'kind' = any (array['class10', 'class12', 'placements', 'alumni', 'award', 'other']))
                or char_length(btrim(coalesce(a->>'text', ''))) not between 3 and 300
                or (a->>'year' is not null and (a->>'year') !~ '^(19|20)[0-9]{2}$')) then
    raise exception 'unknown kind of achievement, or its text or year is not right';
  end if;
  if p_admission is not null and (jsonb_typeof(p_admission) <> 'object'
     or coalesce(p_admission->>'status', '') not in ('open', 'closed')
     or char_length(coalesce(p_admission->>'evidence', '')) > 400
     or (p_admission->>'year' is not null and p_admission->>'year' !~ '^20[0-9]{2}-[0-9]{2}$')) then
    raise exception 'admission must have status open or closed, a year like 2027-28, and short evidence';
  end if;

  v_has := jsonb_array_length(v_boards) > 0 or p_admission is not null or jsonb_array_length(v_levels) > 0
        or jsonb_array_length(v_facilities) > 0 or jsonb_array_length(v_achievements) > 0;
  insert into public.school_site_findings (school_id, website, pages, boards, levels, facilities, achievements, admission, error, review_status)
    values (p_school, left(p_website, 500), coalesce(p_pages, '[]'::jsonb), v_boards, v_levels, v_facilities, v_achievements,
            p_admission, left(p_error, 500), case when v_has then 'pending' else 'no_findings' end)
    returning id into v_id;
  update public.school_site_findings set review_status = 'superseded'
   where school_id = p_school and review_status = 'pending' and id <> v_id;
  update public.schools set last_site_check_at = now() where id = p_school;
  return v_id;
end;
$$;

-- An admin's decision. p_facilities: the facility keys to accept; p_achievements: which achievements to accept, by
-- their place in the finding's list (0 = the first). Accepting nothing at all rejects the finding.
drop function if exists public.review_site_finding(uuid, text[], boolean, text, text[]);
create or replace function public.review_site_finding(p_finding uuid, p_boards text[], p_use_admission boolean,
                                                      p_note text default null, p_levels text[] default null,
                                                      p_facilities text[] default null, p_achievements int[] default null)
 returns text
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  f public.school_site_findings;
  v_found text[];
  v_found_levels text[];
  v_found_facilities text[];
  v_boards text[] := coalesce(p_boards, '{}');
  v_levels text[] := coalesce(p_levels, '{}');
  v_facilities text[] := coalesce(p_facilities, '{}');
  v_achievements int[] := coalesce(p_achievements, '{}');
  v_verified boolean;
  v_url text;
  v_outcome text;
  h jsonb;
  i int;
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
  select coalesce(array_agg(x->>'facility'), '{}') into v_found_facilities from jsonb_array_elements(f.facilities) x;
  if not (v_facilities <@ v_found_facilities) then
    raise exception 'only facilities found on the website can be accepted';
  end if;
  if exists (select 1 from unnest(v_achievements) n where n < 0 or n >= jsonb_array_length(f.achievements)) then
    raise exception 'only achievements found on the website can be accepted';
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

  -- facilities: added, or refreshed when an earlier website finding put them there; never over what the school
  -- or Kidscover entered
  for h in select x from jsonb_array_elements(f.facilities) x where x->>'facility' = any (v_facilities) loop
    insert into public.school_facilities (school_id, facility, detail, source, source_url, updated_by, updated_at)
    values (f.school_id, h->>'facility', nullif(h->>'detail', ''), 'school website',
            case when coalesce(h->>'url', f.website) ~* '^https?://' then coalesce(h->>'url', f.website) end, auth.uid(), now())
    on conflict (school_id, facility) do update
      set detail = excluded.detail, source_url = excluded.source_url, updated_by = excluded.updated_by, updated_at = now()
      where public.school_facilities.source = 'school website';
  end loop;

  -- achievements: added as they were claimed, unless the school already lists the same text
  foreach i in array v_achievements loop
    h := f.achievements -> i;
    if not exists (select 1 from public.school_achievements a
                    where a.school_id = f.school_id and lower(btrim(a.text)) = lower(btrim(h->>'text'))) then
      insert into public.school_achievements (school_id, kind, text, year, source, source_url, updated_by)
      values (f.school_id, h->>'kind', btrim(h->>'text'), (h->>'year')::int, 'school website',
              case when coalesce(h->>'url', f.website) ~* '^https?://' then coalesce(h->>'url', f.website) end, auth.uid());
    end if;
  end loop;

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

  v_outcome := case when cardinality(v_boards) > 0 or cardinality(v_levels) > 0 or cardinality(v_facilities) > 0
                          or cardinality(v_achievements) > 0 or p_use_admission then 'accepted' else 'rejected' end;
  update public.school_site_findings
     set review_status = v_outcome, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 500)
   where id = p_finding;
  return v_outcome;
end;
$$;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named here as well as PUBLIC.
revoke execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb, jsonb, jsonb),
                          public.review_site_finding(uuid, text[], boolean, text, text[], text[], int[]) from public, anon;
grant execute on function public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb, jsonb, jsonb),
                         public.review_site_finding(uuid, text[], boolean, text, text[], text[], int[]) to authenticated;

notify pgrst, 'reload schema';
