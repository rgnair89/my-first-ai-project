-- supabase/migrations/20260921000300_people_photos.sql
--
-- Photographs of people: a parent's own picture, and a photograph of the child on an admission form.
--
-- These are the most personal things Kidscover holds, so the rules are the tightest in the database:
--
--   * the bucket is private. Nothing here can be read by a link alone, the way a school's photo can. The app asks
--     for a signed address that lasts minutes, and only for a file it is allowed to see.
--   * a parent may write only inside their own two folders, parents/<their id>/ and children/<their id>/, and may
--     read only from them.
--   * a school may see one thing and one thing only: the photograph attached to an admission form sent to that
--     school. Not the parent's picture, not another child's, not a photograph of a child whose family applied
--     somewhere else.
--   * nothing is compulsory. A parent who would rather keep a drawn picture keeps one, and a form with no
--     photograph is a complete form.
--
-- Needs 20260920000300 (the admission form) and 20260921000100 (the profile). Safe to run more than once.

-- ---- where the files live -------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('people', 'people', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---- the two columns that point at a file ---------------------------------------------------------------------
-- These come first, because everything below is written in terms of them.
alter table public.profiles add column if not exists photo_path text;
alter table public.profiles drop constraint if exists profiles_photo_path_check;
alter table public.profiles add constraint profiles_photo_path_check
  check (photo_path is null or photo_path ~ '^parents/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$');

alter table public.admission_applications add column if not exists child_photo_path text;
alter table public.admission_applications drop constraint if exists admission_applications_child_photo_check;
alter table public.admission_applications add constraint admission_applications_child_photo_check
  check (child_photo_path is null or child_photo_path ~ '^children/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$');

-- A name inside the bucket looks like  parents/<the person's id>/<a file name>  or  children/<the same>/<...>.
-- Anything else belongs to nobody and is refused.
create or replace function public.owns_people_folder(p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select auth.uid() is not null
     and split_part(coalesce(p_name, ''), '/', 1) in ('parents', 'children')
     and split_part(coalesce(p_name, ''), '/', 2) = auth.uid()::text
     and split_part(coalesce(p_name, ''), '/', 3) <> '';
$$;
revoke execute on function public.owns_people_folder(text) from public, anon;
grant execute on function public.owns_people_folder(text) to authenticated;

-- The one thing a school may see: the photograph on a form that was sent to that school.
create or replace function public.can_see_child_photo(p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (
    select 1 from public.admission_applications a
     where a.child_photo_path = p_name
       and public.can_edit_school(a.school_id)
  );
$$;
revoke execute on function public.can_see_child_photo(text) from public, anon;
grant execute on function public.can_see_child_photo(text) to authenticated;

drop policy if exists "People see their own photos" on storage.objects;
create policy "People see their own photos" on storage.objects
  for select to authenticated using (bucket_id = 'people' and public.owns_people_folder(name));
drop policy if exists "People add their own photos" on storage.objects;
create policy "People add their own photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'people' and public.owns_people_folder(name));
drop policy if exists "People replace their own photos" on storage.objects;
create policy "People replace their own photos" on storage.objects
  for update to authenticated using (bucket_id = 'people' and public.owns_people_folder(name))
  with check (bucket_id = 'people' and public.owns_people_folder(name));
drop policy if exists "People delete their own photos" on storage.objects;
create policy "People delete their own photos" on storage.objects
  for delete to authenticated using (bucket_id = 'people' and public.owns_people_folder(name));
drop policy if exists "A school sees the child on a form sent to it" on storage.objects;
create policy "A school sees the child on a form sent to it" on storage.objects
  for select to authenticated using (bucket_id = 'people' and public.can_see_child_photo(name));

-- ---- the parent's own picture ------------------------------------------------------------------------------------
-- A person may only ever point at a file in their own folder. The check above cannot say so on its own, because a
-- check constraint is not allowed to ask who is writing; this does.
create or replace function public.profiles_photo_is_own()
 returns trigger
 language plpgsql
 set search_path = ''
as $$
begin
  if new.photo_path is not null and split_part(new.photo_path, '/', 2) <> new.id::text then
    raise exception 'A photo must be in your own folder' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_photo_is_own on public.profiles;
create trigger profiles_photo_is_own before insert or update of photo_path on public.profiles
  for each row execute function public.profiles_photo_is_own();
revoke execute on function public.profiles_photo_is_own() from public, anon, authenticated;

grant update (first_name, last_name, phone_number, language, notify_push, gender, avatar, photo_path)
  on public.profiles to authenticated;

-- ---- the child on an admission form --------------------------------------------------------------------------------
-- The form still goes through the one checked function; it now takes a photograph as well, and refuses one that is
-- not the family's own. Everything else about it is unchanged.
create or replace function public.submit_admission_application(p_school uuid, p_form jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id uuid;
  v_dob date;
  v_year text := btrim(coalesce(p_form->>'academic_year', ''));
  v_start int;
  v_phone text := regexp_replace(coalesce(p_form->>'parent_phone', ''), '[[:space:]()-]', '', 'g');
  v_email text := lower(btrim(coalesce(p_form->>'parent_email', '')));
  v_gender text := nullif(btrim(coalesce(p_form->>'child_gender', '')), '');
  v_photo text := nullif(btrim(coalesce(p_form->>'child_photo_path', '')), '');
begin
  if auth.uid() is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if not public.is_verified_user() then
    raise exception 'Please confirm your email address first' using errcode = '42501';
  end if;
  if p_form is null or jsonb_typeof(p_form) <> 'object' then
    raise exception 'The form is empty' using errcode = '22023';
  end if;
  if not exists (select 1 from public.schools s where s.id = p_school and not s.is_hidden and s.category = 'school') then
    raise exception 'This school does not take applications through Kidscover' using errcode = 'P0002';
  end if;
  if coalesce(p_form->>'consent', 'false') <> 'true' then
    raise exception 'Please agree to share these details with the school' using errcode = '22023';
  end if;
  if (select count(*) from public.admission_applications a
       where a.parent_id = auth.uid() and a.created_at > now() - interval '24 hours') >= 5 then
    raise exception 'daily application limit reached' using errcode = 'P0001';
  end if;
  if coalesce(p_form->>'child_dob', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Give the date of birth like 2021-06-30' using errcode = '22023';
  end if;
  begin
    v_dob := (p_form->>'child_dob')::date;
  exception when others then
    raise exception 'Give the date of birth like 2021-06-30' using errcode = '22023';
  end;
  if v_dob > current_date - 180 or v_dob < current_date - interval '20 years' then
    raise exception 'That date of birth does not look right' using errcode = '22023';
  end if;
  if v_year !~ '^20[0-9]{2}-[0-9]{2}$' then
    raise exception 'Give the academic year like 2027-28' using errcode = '22023';
  end if;
  v_start := left(v_year, 4)::int;
  if right(v_year, 2)::int <> (v_start + 1) % 100
     or v_start not between extract(year from now())::int - 1 and extract(year from now())::int + 2 then
    raise exception 'Give the academic year like 2027-28 (this year or the next two)' using errcode = '22023';
  end if;
  if not (coalesce(p_form->>'class_applying', '') = any (public.admission_classes())) then
    raise exception 'Choose the class you are applying for' using errcode = '22023';
  end if;
  if v_gender is not null and v_gender not in ('girl', 'boy', 'other') then
    raise exception 'Unknown gender' using errcode = '22023';
  end if;
  if coalesce(p_form->>'parent_relation', '') not in ('mother', 'father', 'guardian') then
    raise exception 'Say whether you are the mother, father or guardian' using errcode = '22023';
  end if;
  if v_phone !~ '^\+?[0-9]{10,15}$' then
    raise exception 'Give a phone number with 10 to 15 digits' using errcode = '22023';
  end if;
  if char_length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Give a valid email address' using errcode = '22023';
  end if;
  if coalesce(btrim(p_form->>'pincode'), '') !~ '^[1-9][0-9]{5}$' then
    raise exception 'Give a 6-digit PIN code' using errcode = '22023';
  end if;
  if v_photo is not null and v_photo <> 'children/' || auth.uid()::text || '/' || split_part(v_photo, '/', 3) then
    raise exception 'That photo is not yours' using errcode = '42501';
  end if;
  if v_photo is not null and v_photo !~ '^children/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$' then
    raise exception 'That photo is not yours' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_object_keys(p_form) k
              where k not in ('child_first_name', 'child_last_name', 'child_dob', 'child_gender', 'class_applying', 'academic_year',
                              'current_school', 'parent_name', 'parent_relation', 'parent_phone', 'parent_email', 'address',
                              'pincode', 'notes', 'consent', 'child_photo_path')) then
    raise exception 'Unknown field in the form' using errcode = '22023';
  end if;
  begin
    insert into public.admission_applications (school_id, parent_id, child_first_name, child_last_name, child_dob, child_gender,
                                               class_applying, academic_year, current_school, parent_name, parent_relation,
                                               parent_phone, parent_email, address, pincode, notes, child_photo_path, consent_at)
    values (p_school, auth.uid(), btrim(p_form->>'child_first_name'), btrim(p_form->>'child_last_name'), v_dob, v_gender,
            p_form->>'class_applying', v_year, nullif(btrim(coalesce(p_form->>'current_school', '')), ''),
            btrim(p_form->>'parent_name'), p_form->>'parent_relation', v_phone, v_email,
            btrim(p_form->>'address'), btrim(p_form->>'pincode'),
            nullif(btrim(coalesce(p_form->>'notes', '')), ''), v_photo, now())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'You have already applied to this school for this child' using errcode = 'P0001';
  end;
  return v_id;
end;
$$;
revoke execute on function public.submit_admission_application(uuid, jsonb) from public, anon;
grant execute on function public.submit_admission_application(uuid, jsonb) to authenticated;

-- ---- closing an account -------------------------------------------------------------------------------------------
-- The rows go with the account already. The files are removed by the delete-account function, which is the only
-- thing that can actually take a file out of storage; this lists what is to go, for it and for nobody else.
create or replace function public.my_photo_paths()
 returns table (path text)
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select o.name from storage.objects o
   where o.bucket_id = 'people'
     and (o.name like 'parents/' || auth.uid()::text || '/%' or o.name like 'children/' || auth.uid()::text || '/%')
     and auth.uid() is not null;
$$;
revoke execute on function public.my_photo_paths() from public, anon;
grant execute on function public.my_photo_paths() to authenticated;

notify pgrst, 'reload schema';
