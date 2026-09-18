-- Roles and profile lockdown.
-- Apply to the live project via the SQL editor (or `supabase db push`) AFTER the baseline is marked applied.

-- 1. Three roles, per the PRD personas: parent, school_admin (a school's admissions team),
--    admin (Kidscover platform admin). The old CHECK allowed no 'admin', so every
--    "role = 'admin'" RLS policy and the admin dashboard could never match anyone.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check check (role in ('parent', 'school_admin', 'admin'));

-- 2. Users may edit only their own display fields. role, email, phone and the *_verified flags
--    are managed by the server (the signup trigger / service role). Before this, the UPDATE
--    policy let any signed-in user set their own role.
--    New editable profile columns (gender, avatar, settings...) must be granted here as they are added.
revoke update on public.profiles from anon, authenticated;
grant update (first_name, last_name, phone_number) on public.profiles to authenticated;

-- 3. Remove duplicate / over-broad policies (exact copies of ones that stay, or ALL where
--    parents only need select + insert).
drop policy if exists "Users can view their own profile." on public.profiles;
drop policy if exists "Users can update their own profile." on public.profiles;
drop policy if exists "Public fees are viewable by everyone." on public.school_fees;
drop policy if exists "Parents can view and insert own tickets" on public.tickets;

-- 4. Admin helper (security definer so a profiles policy can use it without recursing into itself)
--    and let admins read profiles - the ticket inbox embeds the parent's name and email.
create or replace function public.is_admin()
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- anon must be able to execute it too: other tables' admin policies read profiles, which now calls
-- is_admin(), so an anonymous request would otherwise fail with "permission denied" instead of
-- getting an empty result. It just returns false for anyone signed out.
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create policy "Admins can view all profiles" on public.profiles
  for select using (public.is_admin());

-- 5. Pin the search_path of the signup trigger function (SECURITY DEFINER with a mutable
--    search_path is a known privilege-escalation footgun). It already schema-qualifies public.profiles.
alter function public.handle_new_user() set search_path = '';
