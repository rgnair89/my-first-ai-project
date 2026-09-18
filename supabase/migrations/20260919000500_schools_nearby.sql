-- schools_nearby(latitude, longitude): every school with its straight-line distance in km from a point, for the parent
-- app's "schools near me". Safe to run more than once.
--
-- The app sends the parent's position (rounded to about 100 m) and chains its usual filters on the result: level, daycare,
-- rating, search, "within N km", and the order (nearest first, A to Z, best rated). Nothing about the parent's position is
-- stored anywhere; the function only reads.
--
--   * Distance is the great-circle ("as the crow flies") distance on a sphere of radius 6371.0088 km, rounded to 0.01 km.
--     It is NOT road distance. Travel time by car comes later, from Google's Routes API.
--   * Runs as the caller (security invoker), so row level security still applies: parents never see hidden schools.
--   * Schools without usable coordinates (missing, out of range, or exactly 0,0) are left out, since a distance to them
--     would be a guess. An invalid or missing position returns no rows instead of an error.
--   * name_sort keeps collation "C" (see the name_sort migration), so "A to Z" is in the same order with or without a
--     position. That is why the result is a named type: the column collation of a RETURNS TABLE function is lost.

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
         q.google_rating, q.google_review_count, q.is_hidden, q.distance_km
  from (
    select s.id, s.name, s.name_sort, s.address, s.website, s.board, s.levels,
           s.google_rating, s.google_review_count, s.is_hidden,
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

-- make the new function visible to the app straight away (the API caches the list of functions)
notify pgrst, 'reload schema';
