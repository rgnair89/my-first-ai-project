-- supabase/migrations/20260920000500_account_and_security.sql
--
-- 1. Deleting your account. A parent can remove themselves and everything about them from the app. The delete-account
--    edge function calls delete_my_account_data() as that person, then removes the sign-in itself, which takes the
--    rest with it. To be sure it is really them, it only works within 15 minutes of entering their password.
--    Conversations they were part of as a school staff member keep the school's words but lose the person.
-- 2. Two-step sign-in for the Partner Portal. Once require_mfa is on, a Kidscover admin or a school's staff member
--    counts as one only when they have signed in with their second step (their authenticator app). Until then they
--    see nothing, so a stolen password alone is not enough to reach a child's details.
--    Switch it on from the portal (Security), or here:  select public.set_require_mfa(true);
--    Locked out (lost the phone with the codes)? In the Supabase SQL editor:
--      update public.security_settings set require_mfa = false where id = 1;
-- 3. A school photo must be a file in Kidscover's own storage, not a picture on someone else's website.
--
-- Needs 20260920000400 first. Safe to run more than once.

-- ==== 1. deleting your account ==========================================================================================
-- A message stays in the conversation when the person who wrote it deletes their account (the family keeps the thread).
alter table public.ticket_messages alter column sender_id drop not null;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.ticket_messages'::regclass and contype = 'f'
     and pg_get_constraintdef(oid) ilike '%sender_id%' and pg_get_constraintdef(oid) not ilike '%on delete set null%';
  if c is not null then
    execute format('alter table public.ticket_messages drop constraint %I', c);
    alter table public.ticket_messages add constraint ticket_messages_sender_id_fkey
      foreign key (sender_id) references auth.users (id) on delete set null;
  end if;
end $$;

-- Did this person prove who they are (password, one-time code, and so on) in the last few minutes?
create or replace function public.recently_signed_in(p_minutes int default 15)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select coalesce((select max((e->>'timestamp')::bigint) from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) e), 0)
         > extract(epoch from now()) - greatest(1, least(coalesce(p_minutes, 15), 60)) * 60;
$$;

-- Everything about this person that would not go by itself when their sign-in is removed.
create or replace function public.delete_my_account_data()
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if not public.recently_signed_in(15) then
    raise exception 'Please enter your password again, then delete your account' using errcode = '42501';
  end if;
  delete from public.school_reviews r
   where exists (select 1 from public.school_review_private p where p.review_id = r.id and p.author_id = v_uid);
  delete from public.admission_applications where parent_id = v_uid;
  delete from public.notifications where user_id = v_uid;
  delete from public.push_devices where user_id = v_uid;
  delete from public.school_staff where user_id = v_uid;
  update public.outbound_clicks set user_id = null where user_id = v_uid;
  update public.school_change_log set changed_by = null where changed_by = v_uid;
  update public.school_change_log set reverted_by = null where reverted_by = v_uid;
end;
$$;

-- ==== 2. two-step sign-in for the portal =================================================================================
create table if not exists public.security_settings (
  id integer primary key default 1 check (id = 1),
  require_mfa boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.security_settings (id) values (1) on conflict (id) do nothing;

-- True when two-step sign-in is not being asked for, or this session has done it.
create or replace function public.mfa_ok()
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select not coalesce((select s.require_mfa from public.security_settings s where s.id = 1), false)
      or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2';
$$;

create or replace function public.is_admin()
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') and public.mfa_ok();
$$;

create or replace function public.is_school_staff(p_school uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.school_staff s where s.school_id = p_school and s.user_id = auth.uid())
     and public.mfa_ok();
$$;

create or replace function public.can_edit_school(p_school uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select public.is_admin()
      or (exists (select 1 from public.school_staff s where s.school_id = p_school and s.user_id = auth.uid())
          and public.mfa_ok());
$$;

-- Switching two-step sign-in on or off is itself a two-step action, so a stolen password cannot turn it off.
create or replace function public.set_require_mfa(p_on boolean)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    raise exception 'Only a Kidscover admin can change this' using errcode = '42501';
  end if;
  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    raise exception 'Set up two-step sign-in for your own account first, then sign in with it' using errcode = '42501';
  end if;
  update public.security_settings set require_mfa = coalesce(p_on, false), updated_by = auth.uid(), updated_at = now() where id = 1;
end;
$$;

alter table public.security_settings enable row level security;
drop policy if exists "Staff can see whether two-step sign-in is required" on public.security_settings;
create policy "Staff can see whether two-step sign-in is required" on public.security_settings
  for select to authenticated using (true);
revoke all on public.security_settings from anon, authenticated;
grant select on public.security_settings to authenticated;

-- ==== 3. a school photo lives in Kidscover's own storage =================================================================
-- The one place the project's own address is written down. Change it here if the project ever moves.
create or replace function public.storage_public_prefix()
 returns text
 language sql
 immutable
 set search_path = ''
as $$
  select 'https://twpcjrpknsqlycdvwtsj.supabase.co/storage/v1/object/public/school-photos/';
$$;

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
    -- the file has to be one uploaded to this school's own folder in Kidscover's storage
    if position(public.storage_public_prefix() || p_school::text || '/' in p_url) <> 1
       or p_url !~ ('^[^[:space:]]+$') or p_url ~ '[?#]' or char_length(p_url) > 500
       or position('/' in right(p_url, char_length(p_url) - char_length(public.storage_public_prefix() || p_school::text || '/'))) > 0 then
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

-- ==== who can call what ==================================================================================================
revoke execute on function public.recently_signed_in(int), public.delete_my_account_data(), public.mfa_ok(),
  public.set_require_mfa(boolean), public.storage_public_prefix(), public.is_school_staff(uuid) from public, anon;
grant execute on function public.recently_signed_in(int), public.delete_my_account_data(), public.mfa_ok(),
  public.set_require_mfa(boolean), public.is_school_staff(uuid) to authenticated;
grant execute on function public.storage_public_prefix() to authenticated, service_role;
-- is_admin stays callable by signed-out visitors: other tables' rules call it, and it simply answers "no" for them.
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;
revoke execute on function public.can_edit_school(uuid) from public, anon;
grant execute on function public.can_edit_school(uuid) to authenticated;

notify pgrst, 'reload schema';
