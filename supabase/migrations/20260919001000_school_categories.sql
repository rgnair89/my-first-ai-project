-- supabase/migrations/20260919001000_school_categories.sql
--
-- Every place gets a category, so the parents' main list holds only schools (preschool to class 12):
--   school        preschools, schools, junior colleges (classes 11-12)
--   after_school  music, dance, karate, swimming, sports, art, abacus, tuition and coaching classes
--   college       degree colleges, universities, engineering, business / management, law, medicine, teacher training
-- The app shows Schools by default, with After-school and Colleges one tap away.
--
-- Places that are not for children at all stay hidden, as before (shops, clinics, offices), and so do classes for adults
-- (driving, gym, IELTS, typing, modelling ...). Colleges and after-school classes that the quality rules used to hide
-- are now shown in their own category instead.
--
-- Both rules read the name first and Google's type second, like the quality rules (20260919000300). An admin can put any
-- single place in any category, or hide it, from the Partner Portal's Categories tab (set_school_category below).
--
-- Run it, then paste the new App.js: the app before it does not know the categories and would show the newly visible
-- colleges and classes in its one list. Safe to run more than once.
-- To change the rules later: replace the functions, then run   update public.schools set name = name;

-- Words that say a place is a regular school, preschool or daycare.
create or replace function public.school_words(p_name text)
 returns boolean
 language sql
 immutable
 set search_path = ''
as $$
  select coalesce(p_name, '') ~* '\y(school|schools|vidyalaya|vidyalay|vidya ?mandir|vidya ?bhavan|vidya ?bhawan|vidyapeeth|vidya ?peeth|vidya ?niketan|shala|pathshala|convent|junior college|jr\.? ?college|high ?school|nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|balwadi|anganwadi|gurukul|day ?care|creche)\y';
$$;

-- Classes for adults, not for children: hidden whatever else the name says ("Driving School" included).
create or replace function public.adult_class_words(p_name text)
 returns boolean
 language sql
 immutable
 set search_path = ''
as $$
  select coalesce(p_name, '') ~* '\y(driving|motor training|typing|shorthand|ielts|toefl|pte|gre|gmat|gym|fitness|zumba|aerobics|modelling|modeling|film|photography|cooking|baking|beauty|make-?up|salon|upsc|mpsc|civil services|banking)\y';
$$;

create or replace function public.school_category(p_name text, p_primary text, p_types text[])
 returns text
 language sql
 immutable
 set search_path = ''
as $$
  select case
    -- 1. classes 11-12: a Junior College is a school here, whatever else the name says
    when n ~* '\y(junior|jr\.?) ?college\y' then 'school'

    -- 2. colleges and universities, even when the name says "school" ("School of Business", "School of Engineering")
    when n ~* '\y(university|polytechnic|engineering|management|business school|mahavidyalaya|mahavidyalay|pharmacy|pharmaceutical|nursing|physiotherapy|dental|medical college|law college|hotel management|catering technology|industrial training|pgdm|m\.? ?b\.? ?a|b\. ?ed|b ed|d\. ?ed|d ed|i\.t\.i\.?|iti)\y'
      or n ~* '\yschool of (business|commerce|economics|law|design|architecture|technology|journalism|media|communication|liberal arts|hospitality|planning)\y'
      or n ~* '\yinstitute of (technology|science|sciences|hotel|design|fashion|mass|law|chartered)\y'
      then 'college'
    when n ~* '\ycollege\y' and not public.school_words(n) then 'college'
    when p_primary = 'university' and not public.school_words(n) then 'college'

    -- 3. an activity school or class, whatever Google calls it: "Dance School", "Music Academy", "School of Music",
    --    "Karate Classes at St. Mary's High School"
    when n ~* '\y(music|dance|dancing|ballet|kathak|bharatanatyam|swim|swimming|skating|cricket|football|soccer|tennis|badminton|basketball|chess|karate|taekwondo|judo|martial arts?|gymnastics|art|arts|drawing|painting|drama|theatre|theater|acting|singing|yoga|robotics|coding|abacus|sports|tuition|tuitions|coaching) ?(school|schools|academy|academies|institute|studio|studios|club|centre|center|classes|class)\y'
      or n ~* '\yschool of (music|dance|performing arts|fine arts|arts?|swimming|cricket|football|chess|acting|drama)\y'
      then 'after_school'

    -- 4. an activity or tuition word in a name that does not say it is a school
    when n ~* '\y(music|musical|dance|dancing|ballet|kathak|bharatanatyam|sangeet|nritya|chess|karate|taekwondo|judo|martial arts?|kung ?fu|yoga|skating|swim|swimming|abacus|vedic maths?|singing|vocal|guitar|piano|keyboard|drums?|violin|tabla|drama|theatre|theater|acting|performing arts|painting|drawing|sketching|art|arts|craft|crafts|robotics|coding|cricket|football|soccer|badminton|tennis|basketball|gymnastics|athletics|sports|phonics|handwriting|calligraphy|olympiad|coaching|classes|class|tuition|tuitions|tutorial|tutorials|tutor|tutors|german|french|spanish|japanese|spoken english|summer camp)\y'
         and not public.school_words(n)
      then 'after_school'
    when p_primary = 'sports_school' and not public.school_words(n) then 'after_school'

    else 'school'
  end
  from (select coalesce(p_name, '') as n) x;
$$;

-- The quality rule, v3. Same as v2 (20260919000300) except: colleges and after-school classes are no longer hidden
-- (they have their own category), classes for adults are, and a few more Google types that are never a school.
create or replace function public.non_school_reason(p_name text, p_primary text, p_types text[])
 returns text
 language sql
 immutable
 set search_path = ''
as $$
  select case
    -- 1. Google files it as something that is never a school
    when p_primary in ('store', 'mosque', 'nail_salon', 'makeup_artist', 'medical_clinic', 'health', 'farm', 'manufacturer',
                       'consultant', 'corporate_office', 'employment_agency', 'service', 'yoga_studio', 'summer_camp_organizer')
      then 'not a school: ' || p_primary
    when p_primary in ('pharmacy', 'drugstore', 'hospital', 'doctor', 'dentist', 'dental_clinic', 'gym', 'fitness_center',
                       'beauty_salon', 'hair_salon', 'spa', 'restaurant', 'cafe', 'real_estate_agency', 'travel_agency',
                       'insurance_agency', 'bank', 'car_dealer', 'car_repair')
         and not public.school_words(n)
      then 'not a school: ' || p_primary

    -- 2. classes for adults
    when public.adult_class_words(n)
      then 'not for children: classes for adults'

    -- 3. colleges and after-school classes are shown, each in its own category
    when public.school_category(p_name, p_primary, p_types) <> 'school'
      then null

    -- 4. Google itself files it as a primary / secondary / pre-school or child care: keep it
    when coalesce(p_types, '{}') && array['primary_school', 'secondary_school', 'preschool', 'child_care_agency']
      then null

    -- 5. filed under an office, organisation, sports or playground type: a school only if the name says so
    when p_primary in ('government_office', 'local_government_office', 'association_or_organization', 'non_profit_organization', 'sports_school', 'playground')
         and not public.school_words(n)
      then 'not a school: ' || p_primary || ' with no school in the name'

    -- 6. "educational institution" is how Google files institutes: hidden when the name reads like one
    when p_primary = 'educational_institution'
         and not public.school_words(n)
         and n ~* '\y(institute|institution|academy|education|educational|edu|centre|center|studio|training|exam|course|courses|career|careers|skill|skills|vocational|tech|technology|computer|computers|language|languages|ignou|neet|jee|foundation|society|trust)\y'
      then 'not a school: institute or classes'

    else null
  end
  from (select coalesce(p_name, '') as n) x;
$$;

alter table public.schools add column if not exists category_override text;
alter table public.schools drop constraint if exists schools_category_override_check;
alter table public.schools add constraint schools_category_override_check
  check (category_override is null or category_override in ('school', 'after_school', 'college'));
alter table public.schools
  add column if not exists category text
    generated always as (coalesce(category_override, public.school_category(name, google_primary_type, google_types))) stored;
create index if not exists schools_category_idx on public.schools (category);

-- An admin puts one place in a category ('school', 'after_school', 'college'; this also shows it if a rule hid it),
-- hides it ('hidden'), or hands it back to the rules ('auto').
create or replace function public.set_school_category(p_school uuid, p_choice text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change a school''s category' using errcode = '42501';
  end if;
  if p_choice is null or p_choice not in ('auto', 'school', 'after_school', 'college', 'hidden') then
    raise exception 'Unknown category: %', coalesce(p_choice, 'none') using errcode = '22023';
  end if;
  update public.schools
     set category_override = case when p_choice in ('school', 'after_school', 'college') then p_choice end,
         hidden_override = case when p_choice = 'hidden' then true when p_choice = 'auto' then null else false end
   where id = p_school;
  if not found then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_school_category(uuid, text) from public, anon;
grant execute on function public.set_school_category(uuid, text) to authenticated;
revoke all on function public.school_category(text, text, text[]) from public, anon;
revoke all on function public.school_words(text) from public, anon;
revoke all on function public.adult_class_words(text) from public, anon;
grant execute on function public.school_category(text, text, text[]) to authenticated, service_role;
grant execute on function public.school_words(text) to authenticated, service_role;
grant execute on function public.adult_class_words(text) to authenticated, service_role;

-- The same distance function as in 20260919000800, with the category added so the app can ask for one category near
-- the parent.
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
         q.admissions_checked_at, q.distance_km
  from (
    select s.id, s.name, s.name_sort, s.address, s.website, s.board, s.levels,
           s.google_rating, s.google_review_count, s.is_hidden, s.category,
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

-- recalculate category, is_hidden and auto_hidden_reason for every school with the new rules
update public.schools set name = name;

notify pgrst, 'reload schema';
