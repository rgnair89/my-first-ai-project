-- Quality rules v2. Safe to run more than once. Replaces the rule from 20260919000200, which hid real schools.
--
-- What went wrong: Google files many real schools under other types (government_office, association_or_organization,
-- educational_institution) - "Arunodaya Public School", "Narayana Schools", "NES School For Deaf". Judging by type alone
-- hid about a third of what it hid. v2 reads the name first:
--   * a name that says it is a school ("... School", "Vidyalaya", "Vidya Mandir", "Junior College", ...) keeps the place
--     visible, whatever type Google chose - unless the name is really a class or activity ("School of Music", "Swim School")
--   * places Google files as a shop, mosque, clinic, salon, farm etc. are always hidden
--   * "educational institution" places are hidden only when the name reads like an institute or classes
-- Any single school can still be forced with hidden_override (true = hide, false = show).
--
-- To change the rules later: replace this function, then run   update public.schools set name = name;

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

    -- 2. Google itself files it as a primary / secondary / pre-school or child care: keep it
    when coalesce(p_types, '{}') && array['primary_school', 'secondary_school', 'preschool', 'child_care_agency']
      then null

    -- 3. the name says it is a class or an activity (even if the name also says "school": "School of Music")
    when coalesce(p_name, '') ~* '\y(music|dance|dancing|chess|karate|taekwondo|judo|yoga|skating|swim|swimming|driving|typing|abacus|ielts|toefl|film|acting|modelling|modeling|singing|guitar|piano|drama|painting|photography|cooking|fitness|gym|zumba|cricket|football|badminton|tennis|coaching|classes|tuition|tuitions|tutorial|tutorials|german|french|spanish|japanese)\y'
         or coalesce(p_name, '') ~* '\ymotor training\y'
         or (coalesce(p_name, '') ~* '\yclass\y'
             and coalesce(p_name, '') !~* '\y(school|schools|vidyalaya|vidya ?mandir|vidya ?bhavan|vidya ?bhawan|vidyapeeth|vidya ?peeth|vidya ?niketan|pathshala|convent|junior college|jr\.? college|high ?school)\y')
      then 'not a school: name looks like a class or activity'

    -- 4. filed under an office, organisation, sports or playground type: a school only if the name says so
    when p_primary in ('government_office', 'local_government_office', 'association_or_organization', 'non_profit_organization', 'sports_school', 'playground')
         and coalesce(p_name, '') !~* '\y(school|schools|vidyalaya|vidyalay|vidya ?mandir|vidya ?bhavan|vidya ?bhawan|vidyapeeth|vidya ?peeth|vidya ?niketan|shala|pathshala|convent|junior college|jr\.? college|high ?school|nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|balwadi|anganwadi|gurukul)\y'
      then 'not a school: ' || p_primary || ' with no school in the name'

    -- 5. colleges and universities (a Junior College is classes 11-12, so it stays)
    when p_primary = 'university'
         and coalesce(p_name, '') !~* '\y(school|schools|vidyalaya|vidyalay|vidya ?mandir|vidya ?bhavan|vidya ?bhawan|vidyapeeth|vidya ?peeth|vidya ?niketan|shala|pathshala|convent|junior college|jr\.? college|high ?school|nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|balwadi|anganwadi|gurukul)\y'
      then 'not a school: university or college'

    -- 6. "educational institution" is how Google files institutes and classes: hide only when the name reads like one
    when p_primary = 'educational_institution'
         and coalesce(p_name, '') !~* '\y(school|schools|vidyalaya|vidyalay|vidya ?mandir|vidya ?bhavan|vidya ?bhawan|vidyapeeth|vidya ?peeth|vidya ?niketan|shala|pathshala|convent|junior college|jr\.? college|high ?school|nursery|kindergarten|pre-?school|play ?group|play ?school|montessori|balwadi|anganwadi|gurukul)\y'
         and coalesce(p_name, '') ~* '\y(institute|institution|academy|education|educational|edu|centre|center|studio|training|exam|course|courses|career|careers|skill|skills|vocational|tech|technology|computer|computers|language|languages|ignou|neet|jee|college|foundation|society|trust)\y'
      then 'not a school: institute or classes'

    else null
  end;
$$;

-- recalculate is_hidden / auto_hidden_reason for every school with the new rule
update public.schools set name = name;
