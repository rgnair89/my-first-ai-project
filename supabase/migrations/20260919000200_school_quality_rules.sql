-- Keeps places that are not schools out of the app, and sharpens the level rules. Safe to run more than once.
--
-- 1. schools.is_hidden: true for places that are clearly not K-12 / preschool schools - government offices, colleges,
--    music / chess / driving classes, shops, etc. It is DERIVED from Google's primary type and the name, so every
--    future sweep is covered automatically, and an admin can override any single school with hidden_override
--    (true = always hide, false = always show, null = follow the rule).
--        update public.schools set hidden_override = false where id = '<school id>';   -- show a school the rule hid
-- 2. The public can no longer read hidden schools (row level security); admins and the ingest still can.
-- 3. derive_levels v2: also reads "Highschool" (one word), "Balwadi" and "Anganwadi".
--
-- To change the rules later: replace the function, then run   update public.schools set name = name;

create or replace function public.non_school_reason(p_name text, p_primary text, p_types text[])
 returns text
 language sql
 immutable
 set search_path = ''
as $$
  select case
    -- places Google itself files under something other than a school
    when p_primary in ('government_office', 'local_government_office', 'association_or_organization',
                       'non_profit_organization', 'store', 'consultant', 'corporate_office', 'employment_agency',
                       'farm', 'health', 'makeup_artist', 'manufacturer', 'medical_clinic', 'mosque', 'nail_salon',
                       'playground', 'service', 'summer_camp_organizer', 'yoga_studio', 'sports_school')
      then 'not a school: ' || p_primary
    -- colleges and universities (a Junior College is classes 11-12, so it stays)
    when p_primary = 'university' and coalesce(p_name, '') !~* '\y(junior|jr\.?) ?college\y'
      then 'not a school: university or college'
    -- "educational institution" is how Google files music, coaching and driving classes; a real school has a school type too
    when p_primary = 'educational_institution'
         and not (coalesce(p_types, '{}') && array['primary_school', 'secondary_school', 'preschool', 'child_care_agency'])
      then 'not a school: institute or classes'
    -- the name says it is a class or an activity (unless Google also files it as a school / preschool)
    when not (coalesce(p_types, '{}') && array['primary_school', 'secondary_school', 'preschool', 'child_care_agency'])
         and (coalesce(p_name, '') ~* '\y(classes|coaching|tuitions?|tutorials?|dance|music|chess|karate|yoga|skating|abacus|ielts|driving|typing)\y'
              or (coalesce(p_name, '') ~* '\yclass\y' and coalesce(p_name, '') !~* 'school|vidyalaya|vidyamandir|college|academy|convent'))
      then 'not a school: name looks like a class or activity'
    else null
  end;
$$;

create or replace function public.derive_levels(p_name text, p_types text[])
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select case when p_types is null and cardinality(found) = 0 then null else found end
  from (
    select array_remove(array[
      case when 'child_care_agency' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '\y(day ?care|creche|crèche)\y' then 'daycare' end,
      case when 'preschool' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '\y(nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|pre[ -]?primary|jr\.? ?kg|sr\.? ?kg|balwadi|anganwadi)\y' then 'preschool' end,
      case when 'primary_school' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '(?<!pre[ -])\yprimary\y' then 'primary' end,
      case when 'secondary_school' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '\y(secondary|high ?school|junior college|jr\.? college|higher secondary)\y' then 'secondary' end
    ], null) as found
  ) x;
$$;

alter table public.schools add column if not exists hidden_override boolean;
alter table public.schools
  add column if not exists auto_hidden_reason text
    generated always as (public.non_school_reason(name, google_primary_type, google_types)) stored;
alter table public.schools
  add column if not exists is_hidden boolean
    generated always as (coalesce(hidden_override, public.non_school_reason(name, google_primary_type, google_types) is not null)) stored;

drop policy if exists "Public schools are viewable by everyone." on public.schools;
drop policy if exists "Schools that are not hidden are public" on public.schools;
drop policy if exists "Admins can view every school" on public.schools;
create policy "Schools that are not hidden are public" on public.schools
  for select using (not is_hidden);
create policy "Admins can view every school" on public.schools
  for select using (public.is_admin());

create index if not exists schools_is_hidden_idx on public.schools (is_hidden);

-- recalculate the derived columns (levels, auto_hidden_reason, is_hidden) for every existing school
update public.schools set name = name;
