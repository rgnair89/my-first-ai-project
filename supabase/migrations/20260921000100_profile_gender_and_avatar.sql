-- Profiles: how someone is addressed, and the picture they are shown as.
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- Two columns:
--   gender  - how the parent describes themselves. "prefer_not_to_say" is a real answer, not a missing one, so that
--             a person can finish their profile without telling us something they would rather keep.
--   avatar  - which drawn picture stands for them. Every picture is drawn by the app in code, so there is nothing
--             to license, nothing to upload and nothing of anyone's face on a server. 'auto' follows the gender.
--
-- What is deliberately NOT here: a photograph. Uploading one needs a place to put it and a way to take it down
-- again, and that is its own piece of work; until then nobody's photograph is asked for or stored.

-- ---- the answers the app offers ------------------------------------------------------------------------------------
create or replace function public.profile_genders()
 returns text[] language sql immutable parallel safe
as $$ select array['woman', 'man', 'other', 'prefer_not_to_say']; $$;

create or replace function public.profile_avatars()
 returns text[] language sql immutable parallel safe
as $$ select array['auto', 'parent_one', 'parent_two', 'parent_three', 'parent_four', 'parent_five', 'parent_six']; $$;

alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists avatar text not null default 'auto';

alter table public.profiles drop constraint if exists profiles_gender_check;
alter table public.profiles add constraint profiles_gender_check
  check (gender is null or gender = any (public.profile_genders()));

alter table public.profiles drop constraint if exists profiles_avatar_check;
alter table public.profiles add constraint profiles_avatar_check
  check (avatar is not null and avatar = any (public.profile_avatars()));

-- ---- what a person may change about themselves -----------------------------------------------------------------
-- Row level security already limits anyone to their own row; this says which columns of it they may write.
-- Their role, their email and whether it is confirmed stay out of reach, as before.
grant update (first_name, last_name, phone_number, language, notify_push, gender, avatar) on public.profiles to authenticated;

-- ---- is the profile finished? ---------------------------------------------------------------------------------
-- The app asks a new parent for their name and how to address them before it asks them to apply anywhere. This
-- says whether that has been done, so the app does not have to guess from a handful of columns and get it wrong.
-- It reads only the row belonging to whoever is asking.
create or replace function public.my_profile_complete()
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select coalesce((
    select nullif(btrim(p.first_name), '') is not null
       and nullif(btrim(p.last_name), '') is not null
       and p.gender is not null
    from public.profiles p
    where p.id = auth.uid()
  ), false);
$$;
revoke execute on function public.my_profile_complete() from public, anon;
grant execute on function public.my_profile_complete() to authenticated;

-- ---- the sign-up trigger ---------------------------------------------------------------------------------------
-- Sign-up can now carry a gender chosen on the sign-up screen. Anything else is ignored, exactly as the language is.
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_lang text := new.raw_user_meta_data->>'language';
  v_gender text := new.raw_user_meta_data->>'gender';
begin
  insert into public.profiles (id, email, phone, email_verified, phone_verified, first_name, last_name, language, gender)
  values (
    new.id,
    new.email,
    new.phone,
    (new.email_confirmed_at is not null),
    (new.phone_confirmed_at is not null),
    left(new.raw_user_meta_data->>'first_name', 60),
    left(new.raw_user_meta_data->>'last_name', 60),
    case when v_lang = any (public.app_languages()) then v_lang end,
    case when v_gender = any (public.profile_genders()) then v_gender end
  );
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
