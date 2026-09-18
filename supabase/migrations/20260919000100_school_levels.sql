-- The level(s) a school serves, for the app's level filter: daycare, preschool, primary, secondary.
-- Sources: Google's place types (child_care_agency, preschool, primary_school, secondary_school) and levels the
-- school's own name states ("... Primary School", "Nursery", "Junior College"). Nothing is guessed beyond that.
--   NULL = nothing known yet (a school stored before types were captured)
--   {}   = a school whose level is not stated anywhere (shown as "School - level not specified")
-- To change the rules: replace the function below, then run   update public.schools set name = name;
-- (a generated column is only recalculated when its row is written).
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
                or coalesce(p_name, '') ~* '\y(nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|pre[ -]?primary|jr\.? ?kg|sr\.? ?kg)\y' then 'preschool' end,
      case when 'primary_school' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '(?<!pre[ -])\yprimary\y' then 'primary' end,
      case when 'secondary_school' = any(coalesce(p_types, '{}'))
                or coalesce(p_name, '') ~* '\y(secondary|high school|junior college|jr\.? college|higher secondary)\y' then 'secondary' end
    ], null) as found
  ) x;
$$;

alter table public.schools
  add column if not exists levels text[] generated always as (public.derive_levels(name, google_types)) stored;

create index if not exists schools_levels_idx on public.schools using gin (levels);
