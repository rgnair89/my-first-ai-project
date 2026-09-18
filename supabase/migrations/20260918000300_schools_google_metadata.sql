-- Extra facts Google returns for every place, kept so we can classify schools (preschool / daycare vs
-- primary / secondary) and hide permanently closed listings without crawling again.
--   google_types           e.g. {school,primary_school,point_of_interest}
--   google_primary_type    Google's single best type for the place
--   google_business_status OPERATIONAL, CLOSED_TEMPORARILY or CLOSED_PERMANENTLY
alter table public.schools
  add column if not exists google_types text[],
  add column if not exists google_primary_type text,
  add column if not exists google_business_status text;
