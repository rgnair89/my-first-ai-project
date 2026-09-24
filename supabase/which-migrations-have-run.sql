-- Which migrations have run?
--
-- Paste this whole file into the Supabase SQL Editor and run it. It only reads; it changes nothing.
--
-- Migrations are pasted in by hand, so Supabase keeps no list of which ones were applied. This works it out the only
-- honest way: for each migration it looks for something that migration creates. "yes" means that thing is there.
--
-- Every migration is safe to run more than once, so if a row says "no", just run that file and the ones after it, in
-- order, and run this again.
with checks(ord, migration, looks_for, found) as (
  values
    (1,  '20260918000000_baseline_reconstructed',            'table schools',
         to_regclass('public.schools') is not null),
    (2,  '20260918000100_roles_and_profile_lockdown',        'function is_admin',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_admin')),
    (3,  '20260918000200_schools_google_place_id',           'schools.google_place_id',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'schools' and column_name = 'google_place_id')),
    (4,  '20260918000300_schools_google_metadata',           'schools.google_types',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'schools' and column_name = 'google_types')),
    (5,  '20260919000000_community_reviews',                 'table school_reviews',
         to_regclass('public.school_reviews') is not null),
    (6,  '20260919000100_school_levels',                     'function derive_levels',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'derive_levels')),
    (7,  '20260919000200_school_quality_rules',              'function non_school_reason',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'non_school_reason')),
    (8,  '20260919000300_school_quality_rules_v2',           'cannot be told apart - it only rewrites a function',
         null::boolean),
    (9,  '20260919000400_school_name_sort',                  'schools.name_sort',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'schools' and column_name = 'name_sort')),
    (10, '20260919000500_schools_nearby',                    'function schools_nearby',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'schools_nearby')),
    (11, '20260919000600_admissions_enquiries',              'function send_enquiry',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'send_enquiry')),
    (12, '20260919000700_drive_times',                       'table commute_settings',
         to_regclass('public.commute_settings') is not null),
    (13, '20260919000800_school_website_findings',           'table school_site_findings',
         to_regclass('public.school_site_findings') is not null),
    (14, '20260919000900_enquiry_read_marks_for_old_threads','cannot be told apart - it only corrects old rows',
         null::boolean),
    (15, '20260919001000_school_categories',                 'function school_category',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'school_category')),
    (16, '20260919001100_levels_from_websites',              'schools.site_levels',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'schools' and column_name = 'site_levels')),
    (17, '20260919001200_school_profiles',                   'table school_staff',
         to_regclass('public.school_staff') is not null),
    (18, '20260919001300_facilities_achievements_from_websites', 'function record_site_finding',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'record_site_finding')),
    (19, '20260919001400_hand_set_levels',                   'schools.profile_levels',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'schools' and column_name = 'profile_levels')),
    (20, '20260920000100_languages_and_settings',            'profiles.language',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'language')),
    (21, '20260920000200_fees_and_start_times',              'table school_fee_schedules',
         to_regclass('public.school_fee_schedules') is not null),
    (22, '20260920000300_partner_schools',                   'table admission_applications',
         to_regclass('public.admission_applications') is not null),
    (23, '20260920000400_notifications',                     'table push_devices',
         to_regclass('public.push_devices') is not null),
    (24, '20260920000500_account_and_security',              'table security_settings',
         to_regclass('public.security_settings') is not null),
    (25, '20260920000600_privileges_tightened',              'anon can no longer write to schools',
         to_regclass('public.schools') is not null
           and not has_table_privilege('anon', 'public.schools', 'INSERT')),
    (26, '20260921000100_profile_gender_and_avatar',        'profiles.gender',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'gender')),
    (27, '20260921000200_parent_addresses',                  'table parent_addresses',
         to_regclass('public.parent_addresses') is not null),
    (28, '20260921000300_people_photos',                      'the people bucket',
         exists (select 1 from storage.buckets b where b.id = 'people'))
)
select
  ord                                                as "#",
  migration,
  looks_for                                          as "looked for",
  case when found then 'yes' when found is null then '-' else 'NO - run this one' end as "has it run?"
from checks
order by ord;
