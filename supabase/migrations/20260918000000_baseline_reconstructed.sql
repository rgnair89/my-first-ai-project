-- Baseline of the live schema, reconstructed on 2026-09-18 from a catalog query
-- (information_schema / pg_policies / pg_trigger / pg_proc). `supabase db pull` needs Docker,
-- which was not available, so this is a faithful transcription, not a dump.
--
-- DO NOT run this against the live database - everything here already exists there.
-- Mark it as applied instead:  supabase migration repair --status applied 20260918000000
--
-- Not captured: indexes, table grants, storage buckets, cron jobs. Re-verify with
-- `supabase db pull` once Docker is available.
--
-- Known problems in the live schema that this file preserves on purpose (fixed later):
--   * profiles.role CHECK allows only parent/school_admin, but the RLS policies and app code use 'admin'.
--   * profiles UPDATE policies do not restrict columns, so users can edit their own role.
--   * school_fees.academic_year / grade_level are NOT NULL with no default, and total_tco is generated.
--   * tickets has no admin_reply column and its status CHECK has no 'answered'.

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  board text,
  established_year integer,
  address text,
  latitude numeric,
  longitude numeric,
  is_partner boolean default false,
  admissions_open boolean default false,
  external_website_url text,
  google_rating numeric,
  created_at timestamptz default now(),
  google_review_count integer default 0,
  student_teacher_ratio text,
  website_url text,
  last_synced_at timestamptz,
  website text,
  last_crawled_at timestamptz
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text,
  last_name text,
  role text default 'parent',
  phone_number text,
  created_at timestamptz default now(),
  email text,
  phone text,
  email_verified boolean default false,
  phone_verified boolean default false,
  constraint profiles_role_check check (role = any (array['parent', 'school_admin']))
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null,
  school_id uuid not null references public.schools (id) on delete cascade,
  ward_first_name text not null,
  ward_last_name text not null,
  ward_dob date not null,
  grade_applied_for text not null,
  status text default 'submitted',
  created_at timestamptz default now(),
  constraint applications_status_check check (status = any (array['submitted', 'under_review', 'accepted', 'rejected']))
);

create table public.school_fees (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null unique references public.schools (id) on delete cascade,
  academic_year text not null,
  grade_level text not null,
  base_tuition_annual numeric default 0,
  transport_annual numeric default 0,
  admission_one_time numeric default 0,
  tech_activity_annual numeric default 0,
  cafeteria_annual numeric default 0,
  total_tco numeric generated always as (base_tuition_annual + transport_annual + admission_one_time + tech_activity_annual + cafeteria_annual) stored,
  created_at timestamptz default now(),
  source_url text,
  fee_pdf_url text
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid not null references public.schools (id) on delete cascade,
  subject text not null,
  status text default 'open',
  created_at timestamptz default now(),
  message text,
  constraint tickets_status_check check (status = any (array['open', 'replied', 'closed']))
);

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  sender_id uuid not null references auth.users (id),
  message text not null,
  created_at timestamptz default now()
);

-- Row level security ---------------------------------------------------------
alter table public.schools enable row level security;
alter table public.profiles enable row level security;
alter table public.applications enable row level security;
alter table public.school_fees enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;  -- no policies exist: nobody but service_role can use it yet

create policy "Public schools are viewable by everyone." on public.schools
  for select using (true);

create policy "Allow public read on school_fees" on public.school_fees
  for select to anon, authenticated using (true);
create policy "Public fees are viewable by everyone." on public.school_fees
  for select using (true);

create policy "Users can view own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "Users can view their own profile." on public.profiles
  for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id);
create policy "Users can update their own profile." on public.profiles
  for update using (auth.uid() = id);

create policy "Parents can view own applications" on public.applications
  for select using (auth.uid() = parent_id);
create policy "Parents can insert own applications" on public.applications
  for insert with check (auth.uid() = parent_id);
create policy "Admins can view all applications" on public.applications
  for select using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
create policy "Admins can update applications" on public.applications
  for update using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

create policy "Allow users to view own tickets" on public.tickets
  for select to authenticated using (auth.uid() = parent_id);
create policy "Allow authenticated insert into tickets" on public.tickets
  for insert to authenticated with check (auth.uid() = parent_id);
create policy "Parents can view and insert own tickets" on public.tickets
  for all using (auth.uid() = parent_id) with check (auth.uid() = parent_id);
create policy "Admins can view and reply to all tickets" on public.tickets
  for all using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- New-user trigger -------------------------------------------------------------
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
as $function$
begin
  insert into public.profiles (
    id,
    email,
    phone,
    email_verified,
    phone_verified,
    first_name,
    last_name
  )
  values (
    new.id,
    new.email,
    new.phone,
    (new.email_confirmed_at is not null),
    (new.phone_confirmed_at is not null),
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name'
  );
  return new;
end;
$function$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
