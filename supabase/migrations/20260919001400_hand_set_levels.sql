-- supabase/migrations/20260919001400_hand_set_levels.sql
--
-- Levels set by hand. A Kidscover admin or the school's own staff can say which levels a school runs (daycare,
-- preschool, primary, secondary) in the Partner Portal's School Profiles tab. Levels set this way REPLACE the ones worked
-- out automatically (from the name, Google and accepted website findings), so a wrong automatic level can be removed
-- too; "back to automatic" hands the school back to the rules. Every change is in the change log and can be undone.
-- The parent app needs no change: it reads schools.levels as before.
--
-- Needs 20260919001100 and 20260919001200 first. Safe to run more than once.

alter table public.schools add column if not exists profile_levels text[];
alter table public.schools add column if not exists profile_levels_source text;
alter table public.schools drop constraint if exists schools_profile_levels_check;
alter table public.schools add constraint schools_profile_levels_check check (
  (profile_levels is null and profile_levels_source is null)
  or (profile_levels is not null and profile_levels_source is not null
      and cardinality(profile_levels) > 0 and profile_levels <@ array['daycare', 'preschool', 'primary', 'secondary']
      and profile_levels_source in ('school', 'kidscover'))
);

-- The levels parents see: set by hand if they were, otherwise the name / Google levels plus accepted website levels
-- (the two-argument combine_levels from 20260919001100), always in the usual order.
create or replace function public.combine_levels(p_derived text[], p_site text[], p_profile text[])
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select case
    when p_profile is not null and cardinality(p_profile) > 0
      then array(select o.l from unnest(array['daycare', 'preschool', 'primary', 'secondary']) with ordinality as o(l, n)
                  where o.l = any (p_profile) order by o.n)
    else public.combine_levels(p_derived, p_site)
  end;
$$;

-- schools.levels is a generated column; it is made again to include the hand-set levels (only if it does not already).
do $$
begin
  if coalesce((select pg_get_expr(d.adbin, d.adrelid)
                 from pg_attrdef d
                 join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                where d.adrelid = 'public.schools'::regclass and a.attname = 'levels'), '') not like '%profile_levels%' then
    alter table public.schools drop column if exists levels;
    alter table public.schools add column levels text[]
      generated always as (public.combine_levels(public.derive_levels(name, google_types), site_levels, profile_levels)) stored;
  end if;
end;
$$;
create index if not exists schools_levels_idx on public.schools using gin (levels);

-- p_levels null = back to automatic. Otherwise at least one of the four levels.
create or replace function public.set_school_levels(p_school uuid, p_levels text[])
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if p_levels is not null and (cardinality(p_levels) = 0 or not (p_levels <@ array['daycare', 'preschool', 'primary', 'secondary'])) then
    raise exception 'Choose at least one of daycare, preschool, primary and secondary, or go back to automatic' using errcode = '22023';
  end if;
  update public.schools
     set profile_levels = case when p_levels is null then null
                               else array(select o.l from unnest(array['daycare', 'preschool', 'primary', 'secondary']) with ordinality as o(l, n)
                                           where o.l = any (p_levels) order by o.n) end,
         profile_levels_source = case when p_levels is null then null else public.editor_source() end
   where id = p_school;
  if not found then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
end;
$$;

-- ---- the change log learns about levels -----------------------------------------------------------------------------
alter table public.school_change_log drop constraint if exists school_change_log_what_check;
alter table public.school_change_log add constraint school_change_log_what_check
  check (what in ('facility', 'achievement', 'photo', 'staff', 'levels'));

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
    else
      v_what := 'staff';
      v_key := coalesce(r_new->>'user_id', r_old->>'user_id');
    end if;
    v_before := r_old - 'school_id' - 'updated_by' - 'updated_at' - 'added_by' - 'added_at';
    v_after := r_new - 'school_id' - 'updated_by' - 'updated_at' - 'added_by' - 'added_at';
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

drop trigger if exists schools_levels_log on public.schools;
create trigger schools_levels_log after update of profile_levels, profile_levels_source on public.schools
  for each row execute function public.log_school_change('levels');

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

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named here as well as PUBLIC.
revoke execute on function public.set_school_levels(uuid, text[]), public.combine_levels(text[], text[], text[]) from public, anon;
grant execute on function public.set_school_levels(uuid, text[]) to authenticated;
grant execute on function public.combine_levels(text[], text[], text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
