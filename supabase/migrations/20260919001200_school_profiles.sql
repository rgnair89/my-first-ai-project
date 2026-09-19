-- supabase/migrations/20260919001200_school_profiles.sql
--
-- A fuller school page: facilities, achievements and a photo, kept up to date by Kidscover admins and by each school's
-- own staff. Every change is logged (who, when, before and after), and a Kidscover admin can undo any of them.
--
-- 1. school_staff: which people may edit which school. A Kidscover admin adds them by email (they sign up first);
--    their role becomes 'school_admin'. They can edit only their own school, in the Partner Portal.
-- 2. school_facilities (one row per facility a school has, from a fixed list, with an optional detail such as a
--    teacher-student ratio of "1:20") and school_achievements (class 10 / 12 results, placements, alumni, awards).
--    Anyone may read them; they are written only through the functions below.
-- 3. A photo on schools: one the school uploaded (Storage bucket "school-photos", folder = the school's id), or a
--    free-licensed Wikimedia Commons photo, always with its credit and licence. No photo: the app draws a school.
-- 4. school_change_log: triggers record every change to the above (and staff added or removed);
--    revert_school_change undoes one.
-- 5. schools_nearby returns the photo too (the app shows it on every card).
-- Safe to run more than once.

-- ---- who may edit which school ---------------------------------------------------------------------------------------
create table if not exists public.school_staff (
  school_id uuid not null references public.schools (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_by uuid default auth.uid(),
  added_at timestamptz not null default now(),
  primary key (school_id, user_id)
);
create index if not exists school_staff_user_idx on public.school_staff (user_id);

create or replace function public.can_edit_school(p_school uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select public.is_admin()
      or exists (select 1 from public.school_staff s where s.school_id = p_school and s.user_id = auth.uid());
$$;

-- ---- what a school has, and what it has achieved -----------------------------------------------------------------------
create or replace function public.facility_keys()
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select array['cafeteria', 'outdoor_playground', 'indoor_play', 'swimming_pool', 'sports_courts', 'library',
               'science_labs', 'computer_lab', 'maths_lab', 'stem_lab', 'ai_lab', 'smart_classes', 'auditorium',
               'art_music', 'transport', 'medical_room', 'cctv', 'air_conditioned', 'special_needs', 'teacher_ratio'];
$$;

create table if not exists public.school_facilities (
  school_id uuid not null references public.schools (id) on delete cascade,
  facility text not null check (facility = any (public.facility_keys())),
  detail text check (detail is null or char_length(detail) between 1 and 120),
  source text not null check (source in ('school', 'school website', 'kidscover')),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (school_id, facility)
);

create table if not exists public.school_achievements (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  kind text not null check (kind in ('class10', 'class12', 'placements', 'alumni', 'award', 'other')),
  text text not null check (char_length(btrim(text)) between 3 and 300),
  year int check (year is null or year between 1900 and 2100),
  source text not null check (source in ('school', 'school website', 'kidscover')),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists school_achievements_school_idx on public.school_achievements (school_id, kind, year desc);

-- ---- a photo -------------------------------------------------------------------------------------------------------------
alter table public.schools add column if not exists photo_url text;
alter table public.schools add column if not exists photo_source text;
alter table public.schools add column if not exists photo_credit text;
alter table public.schools add column if not exists photo_licence text;
alter table public.schools add column if not exists photo_page_url text;
alter table public.schools add column if not exists photo_updated_at timestamptz;
alter table public.schools drop constraint if exists schools_photo_check;
alter table public.schools add constraint schools_photo_check check (
  (photo_url is null and photo_source is null)
  or (photo_source = 'school' and photo_url ~ '^https://[a-z0-9.-]+/storage/v1/object/public/school-photos/')
  or (photo_source = 'wikimedia' and photo_url ~ '^https://upload\.wikimedia\.org/' and photo_credit is not null
      and photo_licence is not null and photo_page_url ~ '^https://commons\.wikimedia\.org/')
) not valid;

-- ---- the change log --------------------------------------------------------------------------------------------------
create table if not exists public.school_change_log (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  what text not null check (what in ('facility', 'achievement', 'photo', 'staff')),
  record_key text not null,
  action text not null check (action in ('added', 'changed', 'removed')),
  before jsonb,
  after jsonb,
  changed_by uuid,
  changed_by_role text,
  changed_at timestamptz not null default now(),
  reverts bigint references public.school_change_log (id),
  reverted_by uuid,
  reverted_at timestamptz
);
create index if not exists school_change_log_school_idx on public.school_change_log (school_id, changed_at desc);
create index if not exists school_change_log_recent_idx on public.school_change_log (changed_at desc);

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
  if tg_table_name = 'schools' then
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

drop trigger if exists school_facilities_log on public.school_facilities;
create trigger school_facilities_log after insert or update or delete on public.school_facilities
  for each row execute function public.log_school_change();
drop trigger if exists school_achievements_log on public.school_achievements;
create trigger school_achievements_log after insert or update or delete on public.school_achievements
  for each row execute function public.log_school_change();
drop trigger if exists school_staff_log on public.school_staff;
create trigger school_staff_log after insert or delete on public.school_staff
  for each row execute function public.log_school_change();
drop trigger if exists schools_photo_log on public.schools;
create trigger schools_photo_log after update of photo_url, photo_source, photo_credit, photo_licence, photo_page_url on public.schools
  for each row execute function public.log_school_change();

-- ---- writing, for Kidscover admins and the school's own staff ------------------------------------------------------------
create or replace function public.editor_source()
 returns text
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select case when public.is_admin() then 'kidscover' else 'school' end;
$$;

create or replace function public.set_school_facility(p_school uuid, p_facility text, p_has boolean, p_detail text default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if not (p_facility = any (public.facility_keys())) then
    raise exception 'Unknown facility: %', coalesce(p_facility, 'none') using errcode = '22023';
  end if;
  if char_length(v_detail) > 120 then
    raise exception 'The detail is too long (120 characters at most)' using errcode = '22023';
  end if;
  if p_facility = 'teacher_ratio' and p_has and (v_detail is null or v_detail !~ '^1\s*:\s*[0-9]{1,3}$') then
    raise exception 'Give the teacher-student ratio like 1:20' using errcode = '22023';
  end if;
  if p_has then
    insert into public.school_facilities (school_id, facility, detail, source, source_url, updated_by, updated_at)
    values (p_school, p_facility, case when p_facility = 'teacher_ratio' then regexp_replace(v_detail, '\s', '', 'g') else v_detail end,
            public.editor_source(), null, auth.uid(), now())
    on conflict (school_id, facility) do update
      set detail = excluded.detail, source = excluded.source, source_url = null, updated_by = excluded.updated_by, updated_at = now();
  else
    delete from public.school_facilities where school_id = p_school and facility = p_facility;
  end if;
end;
$$;

create or replace function public.save_school_achievement(p_school uuid, p_id uuid, p_kind text, p_text text,
                                                          p_year int default null, p_url text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id uuid;
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('class10', 'class12', 'placements', 'alumni', 'award', 'other') then
    raise exception 'Unknown kind of achievement: %', coalesce(p_kind, 'none') using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_text, ''))) not between 3 and 300 then
    raise exception 'Describe the achievement in 3 to 300 characters' using errcode = '22023';
  end if;
  if p_year is not null and p_year not between 1900 and extract(year from now())::int + 1 then
    raise exception 'That year does not look right' using errcode = '22023';
  end if;
  if v_url is not null and v_url !~* '^https?://' then
    raise exception 'The link must start with http:// or https://' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.school_achievements (school_id, kind, text, year, source, source_url, updated_by)
    values (p_school, p_kind, btrim(p_text), p_year, public.editor_source(), v_url, auth.uid())
    returning id into v_id;
  else
    update public.school_achievements
       set kind = p_kind, text = btrim(p_text), year = p_year, source = public.editor_source(), source_url = v_url,
           updated_by = auth.uid(), updated_at = now()
     where id = p_id and school_id = p_school
    returning id into v_id;
    if v_id is null then
      raise exception 'No such achievement for this school' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_school_achievement(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_school uuid;
begin
  select school_id into v_school from public.school_achievements where id = p_id;
  if v_school is null then
    raise exception 'No such achievement' using errcode = 'P0002';
  end if;
  if not public.can_edit_school(v_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  delete from public.school_achievements where id = p_id;
end;
$$;

-- p_url null removes the photo. 'school': a file in the school-photos bucket, in this school's folder.
-- 'wikimedia': a Wikimedia Commons file, with its author credit, licence and the Commons page it came from.
create or replace function public.set_school_photo(p_school uuid, p_url text, p_source text default null, p_credit text default null,
                                                   p_licence text default null, p_page_url text default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.can_edit_school(p_school) then
    raise exception 'You can only change your own school' using errcode = '42501';
  end if;
  if p_url is null then
    update public.schools set photo_url = null, photo_source = null, photo_credit = null, photo_licence = null,
                              photo_page_url = null, photo_updated_at = now()
     where id = p_school;
    return;
  end if;
  if p_source = 'school' then
    if p_url !~ ('^https://[a-z0-9.-]+/storage/v1/object/public/school-photos/' || p_school::text || '/[^/?#]+$') then
      raise exception 'A school photo must be uploaded to this school''s folder first' using errcode = '22023';
    end if;
  elsif p_source = 'wikimedia' then
    if p_url !~ '^https://upload\.wikimedia\.org/' or coalesce(p_page_url, '') !~ '^https://commons\.wikimedia\.org/'
       or char_length(btrim(coalesce(p_credit, ''))) not between 1 and 200 or char_length(btrim(coalesce(p_licence, ''))) not between 1 and 100 then
      raise exception 'A Wikimedia photo needs its file address, its Commons page, the author and the licence' using errcode = '22023';
    end if;
  else
    raise exception 'Unknown photo source: %', coalesce(p_source, 'none') using errcode = '22023';
  end if;
  update public.schools
     set photo_url = p_url, photo_source = p_source,
         photo_credit = case when p_source = 'wikimedia' then btrim(p_credit) else nullif(btrim(coalesce(p_credit, '')), '') end,
         photo_licence = case when p_source = 'wikimedia' then btrim(p_licence) end,
         photo_page_url = case when p_source = 'wikimedia' then p_page_url end,
         photo_updated_at = now()
   where id = p_school;
end;
$$;

-- ---- staff, managed by Kidscover admins ----------------------------------------------------------------------------------
create or replace function public.add_school_staff(p_school uuid, p_email text)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_user uuid;
  v_role text;
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can add school staff' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools where id = p_school) then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
  select id, role into v_user, v_role from public.profiles where lower(email) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if v_user is null then
    raise exception 'Nobody has signed up with that email yet. Ask them to create an account first.' using errcode = 'P0002';
  end if;
  insert into public.school_staff (school_id, user_id) values (p_school, v_user) on conflict do nothing;
  if v_role = 'parent' then
    update public.profiles set role = 'school_admin' where id = v_user;
  end if;
  return v_user;
end;
$$;

create or replace function public.remove_school_staff(p_school uuid, p_user uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can remove school staff' using errcode = '42501';
  end if;
  delete from public.school_staff where school_id = p_school and user_id = p_user;
  if not exists (select 1 from public.school_staff where user_id = p_user) then
    update public.profiles set role = 'parent' where id = p_user and role = 'school_admin';
  end if;
end;
$$;

-- ---- undo ----------------------------------------------------------------------------------------------------------------
-- Puts one logged change back the way it was. Only the latest change to that facility / achievement / photo can be
-- undone (undoing an older one would silently overwrite what came after). The undo is itself logged.
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

-- ---- who can read what -----------------------------------------------------------------------------------------------
alter table public.school_staff enable row level security;
alter table public.school_facilities enable row level security;
alter table public.school_achievements enable row level security;
alter table public.school_change_log enable row level security;

drop policy if exists "Staff rows: admins, and each person their own" on public.school_staff;
create policy "Staff rows: admins, and each person their own" on public.school_staff
  for select to authenticated using (public.is_admin() or user_id = auth.uid());
-- facilities and achievements are public for every school a visitor can see (hidden places stay hidden)
drop policy if exists "Facilities of visible schools are public" on public.school_facilities;
create policy "Facilities of visible schools are public" on public.school_facilities
  for select using (exists (select 1 from public.schools s where s.id = school_id));
drop policy if exists "Achievements of visible schools are public" on public.school_achievements;
create policy "Achievements of visible schools are public" on public.school_achievements
  for select using (exists (select 1 from public.schools s where s.id = school_id));
drop policy if exists "Change log: admins, and a school's own staff" on public.school_change_log;
create policy "Change log: admins, and a school's own staff" on public.school_change_log
  for select to authenticated using (public.can_edit_school(school_id));

revoke all on public.school_staff, public.school_facilities, public.school_achievements, public.school_change_log from anon, authenticated;
grant select on public.school_facilities, public.school_achievements to anon, authenticated;
grant select on public.school_staff, public.school_change_log to authenticated;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named as well as PUBLIC.
revoke execute on function public.can_edit_school(uuid), public.editor_source(), public.log_school_change(),
  public.set_school_facility(uuid, text, boolean, text), public.save_school_achievement(uuid, uuid, text, text, int, text),
  public.delete_school_achievement(uuid), public.set_school_photo(uuid, text, text, text, text, text),
  public.add_school_staff(uuid, text), public.remove_school_staff(uuid, uuid), public.revert_school_change(bigint)
  from public, anon;
grant execute on function public.can_edit_school(uuid),
  public.set_school_facility(uuid, text, boolean, text), public.save_school_achievement(uuid, uuid, text, text, int, text),
  public.delete_school_achievement(uuid), public.set_school_photo(uuid, text, text, text, text, text),
  public.add_school_staff(uuid, text), public.remove_school_staff(uuid, uuid), public.revert_school_change(bigint)
  to authenticated;

-- ---- photo uploads: public to view, only the school's staff (or a Kidscover admin) may add to its folder ----------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('school-photos', 'school-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_edit_school_folder(p_name text)
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path = ''
as $$
declare
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
begin
  if v_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.can_edit_school(v_folder::uuid);
end;
$$;
revoke execute on function public.can_edit_school_folder(text) from public, anon;
grant execute on function public.can_edit_school_folder(text) to authenticated;

drop policy if exists "School staff upload their school's photos" on storage.objects;
create policy "School staff upload their school's photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'school-photos' and public.can_edit_school_folder(name));
drop policy if exists "School staff replace their school's photos" on storage.objects;
create policy "School staff replace their school's photos" on storage.objects
  for update to authenticated using (bucket_id = 'school-photos' and public.can_edit_school_folder(name))
  with check (bucket_id = 'school-photos' and public.can_edit_school_folder(name));
drop policy if exists "School staff delete their school's photos" on storage.objects;
create policy "School staff delete their school's photos" on storage.objects
  for delete to authenticated using (bucket_id = 'school-photos' and public.can_edit_school_folder(name));

-- The same distance function as in 20260919001000, with the photo columns added: the app shows each school's photo
-- in "near me" lists too.
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
  photo_url text,
  photo_source text,
  photo_credit text,
  photo_licence text,
  photo_page_url text,
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
         q.admissions_checked_at, q.photo_url, q.photo_source, q.photo_credit, q.photo_licence, q.photo_page_url, q.distance_km
  from (
    select s.id, s.name, s.name_sort, s.address, s.website, s.board, s.levels,
           s.google_rating, s.google_review_count, s.is_hidden, s.category,
           s.boards, s.board_source, s.board_source_url, s.admissions_open, s.admissions_year, s.admissions_source_url,
           s.admissions_checked_at, s.photo_url, s.photo_source, s.photo_credit, s.photo_licence, s.photo_page_url,
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

notify pgrst, 'reload schema';
