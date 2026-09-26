-- 20260926000300_service_areas.sql
--
-- The cities Kidscover covers, so the app stops being about Mumbai in particular.
--
-- Until now one rectangle of the world was written into App.js as a constant, and the same rectangle again into the
-- commute-times function. Two copies of one fact in two repositories: when they drift, the app lets a parent search
-- and the function refuses their drive times, and nothing anywhere says why.
--
-- It also left a parent no way to look at schools in a city they are not standing in. Someone in Bangalore could not
-- see Bangalore schools, and someone visiting Mumbai could not see the schools back home, without inventing an
-- address. That is not a problem of ten cities; it was already a problem with one.
--
-- A city here is mostly a rectangle and a middle. The app measures distance from a point, so choosing a city is
-- choosing a point - the same machinery that already handles "use my location" and a saved address.

create table if not exists public.service_areas (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(name) between 1 and 60),
  -- the rectangle that counts as this city, generous enough to include the towns people commute from
  lat_min numeric not null check (lat_min between -90 and 90),
  lat_max numeric not null check (lat_max between -90 and 90),
  lng_min numeric not null check (lng_min between -180 and 180),
  lng_max numeric not null check (lng_max between -180 and 180),
  -- where the app measures from when somebody picks this city without sharing where they are
  centre_lat numeric not null check (centre_lat between -90 and 90),
  centre_lng numeric not null check (centre_lng between -180 and 180),
  -- A city nobody has collected schools for yet is not shown to parents. Half a city is worse than none: a family
  -- who finds four schools in Pune concludes there are four schools in Pune.
  live boolean not null default false,
  sort_order integer not null default 100,
  updated_at timestamptz not null default now(),
  check (lat_min < lat_max and lng_min < lng_max),
  check (centre_lat between lat_min and lat_max and centre_lng between lng_min and lng_max)
);

comment on table public.service_areas is
  'The cities Kidscover covers. One rectangle and one middle each. "live" is what a parent is offered.';

-- ---- the ten, with Mumbai the only one that has any schools in it yet -------------------------------------------
-- Mumbai's rectangle is exactly the one that was written into App.js and commute-times, so nothing changes for
-- anybody today. The rest are a reasonable first cut and are meant to be adjusted once somebody sweeps them.
insert into public.service_areas (key, name, lat_min, lat_max, lng_min, lng_max, centre_lat, centre_lng, live, sort_order) values
  ('mumbai',      'Mumbai',        18.50, 19.70, 72.50, 73.50, 19.0760, 72.8777, true,  10),
  ('pune',        'Pune',          18.40, 18.70, 73.70, 74.05, 18.5204, 73.8567, false, 20),
  ('delhi_ncr',   'Delhi NCR',     28.20, 28.90, 76.80, 77.60, 28.6139, 77.2090, false, 30),
  ('bangalore',   'Bangalore',     12.75, 13.20, 77.35, 77.85, 12.9716, 77.5946, false, 40),
  ('hyderabad',   'Hyderabad',     17.20, 17.65, 78.20, 78.65, 17.3850, 78.4867, false, 50),
  ('chennai',     'Chennai',       12.80, 13.30, 80.05, 80.35, 13.0827, 80.2707, false, 60),
  ('kolkata',     'Kolkata',       22.40, 22.80, 88.20, 88.50, 22.5726, 88.3639, false, 70),
  ('ahmedabad',   'Ahmedabad',     22.90, 23.15, 72.45, 72.75, 23.0225, 72.5714, false, 80),
  ('kochi',       'Kochi',          9.85, 10.10, 76.20, 76.45,  9.9312, 76.2673, false, 90),
  ('trivandrum',  'Thiruvananthapuram', 8.40, 8.65, 76.85, 77.05, 8.5241, 76.9366, false, 100)
on conflict (key) do nothing;

-- ---- who may read it -------------------------------------------------------------------------------------------
-- A parent has to know which cities exist before signing in, so the live ones are public. The ones being prepared
-- are not: an empty city on a list is a promise nobody made.
alter table public.service_areas enable row level security;

drop policy if exists "Live cities are public" on public.service_areas;
create policy "Live cities are public" on public.service_areas
  for select using (live or public.is_admin());

drop policy if exists "Admins change cities" on public.service_areas;
create policy "Admins change cities" on public.service_areas
  for all using (public.is_admin()) with check (public.is_admin());

revoke all on public.service_areas from anon, authenticated;
grant select on public.service_areas to anon, authenticated;
grant insert, update, delete on public.service_areas to authenticated;

-- ---- which city a school is in ---------------------------------------------------------------------------------
alter table public.schools add column if not exists city text references public.service_areas (key) on delete set null;
create index if not exists schools_by_city on public.schools (city);

comment on column public.schools.city is
  'Which service area this school falls inside, worked out from its position. Null until it has one, or outside them all.';

create or replace function public.city_at(p_lat numeric, p_lng numeric)
 returns text
 language sql
 stable
 set search_path = ''
as $$
  select a.key from public.service_areas a
   where p_lat between a.lat_min and a.lat_max
     and p_lng between a.lng_min and a.lng_max
   order by a.sort_order
   limit 1;
$$;
revoke all on function public.city_at(numeric, numeric) from public;
grant execute on function public.city_at(numeric, numeric) to anon, authenticated, service_role;

-- kept right as schools arrive and move
create or replace function public.set_school_city()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  new.city := case when new.latitude is null or new.longitude is null
                   then null else public.city_at(new.latitude, new.longitude) end;
  return new;
end;
$$;

drop trigger if exists schools_city_from_position on public.schools;
create trigger schools_city_from_position
  before insert or update of latitude, longitude on public.schools
  for each row execute function public.set_school_city();

-- the 4,975 already here
update public.schools
   set city = public.city_at(latitude, longitude)
 where latitude is not null and longitude is not null
   and city is distinct from public.city_at(latitude, longitude);

-- ---- what the app asks for -------------------------------------------------------------------------------------
-- Just the live cities, with how many schools each has, so the app can say "Pune - 1,240 schools" rather than
-- offering a name and hoping.
create or replace view public.cities
with (security_invoker = true) as
  select a.key, a.name, a.lat_min, a.lat_max, a.lng_min, a.lng_max, a.centre_lat, a.centre_lng, a.sort_order,
         (select count(*) from public.schools s where s.city = a.key and not coalesce(s.is_hidden, false)) as schools
    from public.service_areas a
   where a.live
   order by a.sort_order;

comment on view public.cities is
  'The cities a parent may choose between, with how many schools are in each.';

notify pgrst, 'reload schema';
