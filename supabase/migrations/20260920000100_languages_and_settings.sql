-- supabase/migrations/20260920000100_languages_and_settings.sql
--
-- Each person's app settings, kept with their profile so they follow them to a new phone:
--   language     the language the app is shown in. Null until they choose one; the app then asks them to.
--   notify_push  whether they want push notifications (their phone has to allow them too).
-- A language picked on the sign-up screen travels with the sign-up and is saved straight away.
--
-- The languages: English, the 22 languages of the Eighth Schedule (Assamese, Bengali, Bodo, Dogri, Gujarati, Hindi,
-- Kannada, Kashmiri, Konkani, Maithili, Malayalam, Manipuri, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali,
-- Sindhi, Tamil, Telugu, Urdu) and Arabic, German, Spanish, French, Japanese, Portuguese, Russian and Chinese.
-- Safe to run more than once.

create or replace function public.app_languages()
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select array['en', 'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks', 'kok', 'mai', 'ml', 'mni', 'mr', 'ne', 'or', 'pa',
               'sa', 'sat', 'sd', 'ta', 'te', 'ur', 'ar', 'de', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'];
$$;

alter table public.profiles add column if not exists language text;
alter table public.profiles add column if not exists notify_push boolean not null default true;
alter table public.profiles drop constraint if exists profiles_language_check;
alter table public.profiles add constraint profiles_language_check check (language is null or language = any (public.app_languages()));

-- People may change their own settings (row level security already limits them to their own row).
grant update (language, notify_push) on public.profiles to authenticated;

-- The sign-up trigger, as before, plus the language chosen on the sign-up screen (ignored unless it is one we offer).
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_lang text := new.raw_user_meta_data->>'language';
begin
  insert into public.profiles (id, email, phone, email_verified, phone_verified, first_name, last_name, language)
  values (
    new.id,
    new.email,
    new.phone,
    (new.email_confirmed_at is not null),
    (new.phone_confirmed_at is not null),
    left(new.raw_user_meta_data->>'first_name', 60),
    left(new.raw_user_meta_data->>'last_name', 60),
    case when v_lang = any (public.app_languages()) then v_lang end
  );
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.app_languages() from public, anon;
grant execute on function public.app_languages() to authenticated, service_role;

notify pgrst, 'reload schema';
