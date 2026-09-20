-- supabase/migrations/20260920000300_partner_schools.sql
--
-- Partner schools: a school's own staff answer their enquiries and receive admission applications, which can be sent
-- straight on to the school's own admissions system (CRM). Also: a record of parents going out to a school's website.
--
-- 1. Enquiries. A school's staff (school_staff, added by a Kidscover admin) now see and answer the enquiries sent to
--    their own school, in the Partner Portal, alongside Kidscover. They never see a parent's email or surname: the
--    conversation happens in Kidscover. Every message records who wrote it: the parent, the school or Kidscover.
-- 2. The Kidscover Standard admission form (admission_applications). A parent fills it in once per child and school:
--    the child's name, date of birth and the class and year they are applying for, and the parent's contact details
--    and address, with their explicit consent to share them with that school. Readable only by that parent, that
--    school's staff and Kidscover admins. The school moves it through its stages (in review, visit, offered,
--    waitlisted, accepted, declined); the parent can withdraw it, or delete it altogether. Every stage is kept in
--    admission_application_events so the parent sees what happened and when.
-- 3. The CRM webhook. A Kidscover admin can connect a school's admissions system: an https address that receives each
--    new (or withdrawn) application as JSON, signed with a secret only that school and Kidscover know. The secret is
--    kept in a schema the apps cannot reach, and is shown once when it is made. Deliveries queue in crm_deliveries and
--    are sent by the crm-deliver edge function, with retries.
-- 4. outbound_clicks: when a signed-in parent opens a school's own website (or its admission or fee page) from the
--    app. Schools and Kidscover see counts, never who clicked.
--
-- Needs 20260920000200 first. Safe to run more than once.

-- ---- who is on a school's staff ---------------------------------------------------------------------------------------
create or replace function public.is_school_staff(p_school uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.school_staff s where s.school_id = p_school and s.user_id = auth.uid());
$$;

-- a school's staff can see their own school even if it is hidden from parents
drop policy if exists "School staff see their own schools" on public.schools;
create policy "School staff see their own schools" on public.schools
  for select to authenticated using (public.is_school_staff(id));

-- ==== 1. enquiries, answered by the school too ===========================================================================
create or replace function public.can_answer_ticket(p_ticket uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select public.is_admin()
      or exists (select 1 from public.tickets t join public.school_staff s on s.school_id = t.school_id
                  where t.id = p_ticket and s.user_id = auth.uid());
$$;

alter table public.ticket_messages add column if not exists sender_role text;
alter table public.ticket_messages drop constraint if exists ticket_messages_sender_role_check;
alter table public.ticket_messages add constraint ticket_messages_sender_role_check
  check (sender_role is null or sender_role in ('parent', 'school', 'kidscover'));
update public.ticket_messages m
   set sender_role = case when m.sender_id = t.parent_id then 'parent' else 'kidscover' end
  from public.tickets t
 where t.id = m.ticket_id and m.sender_role is null;

create or replace function public.ticket_message_before_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_parent boolean := public.owns_ticket(new.ticket_id);
  v_admin boolean := public.is_admin();
  v_staff boolean;
begin
  if auth.uid() is null then
    raise exception 'sign in to send a message' using errcode = '42501';
  end if;
  v_staff := not v_admin and public.can_answer_ticket(new.ticket_id);
  if not (v_parent or v_admin or v_staff) then
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
  if v_parent and not v_admin and not public.is_verified_user() then
    raise exception 'confirm your email address first' using errcode = '42501';
  end if;
  if (select count(*) from public.ticket_messages m
      where m.sender_id = auth.uid() and m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many messages just now, please wait a little' using errcode = 'P0001';
  end if;
  new.sender_id := auth.uid();     -- nobody writes in someone else's name
  new.sender_role := case when v_parent then 'parent' when v_admin then 'kidscover' else 'school' end;
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.set_ticket_status(p_ticket uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not (public.owns_ticket(p_ticket) or public.can_answer_ticket(p_ticket)) then
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'replied', 'closed') then
    raise exception 'unknown status %', coalesce(p_status, 'none') using errcode = '22023';
  end if;
  update public.tickets set status = p_status where id = p_ticket;
  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.mark_ticket_read(p_ticket uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if public.owns_ticket(p_ticket) then
    update public.tickets set parent_read_at = now() where id = p_ticket;
  elsif public.can_answer_ticket(p_ticket) then
    update public.tickets set staff_read_at = now() where id = p_ticket;
  else
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
end;
$$;

drop policy if exists "School staff see their school's enquiries" on public.tickets;
create policy "School staff see their school's enquiries" on public.tickets
  for select to authenticated using (public.is_school_staff(school_id));
drop policy if exists "Both sides read the messages of their enquiry" on public.ticket_messages;
drop policy if exists "Both sides can write in their enquiry" on public.ticket_messages;
create policy "Both sides read the messages of their enquiry" on public.ticket_messages
  for select to authenticated using (public.owns_ticket(ticket_id) or public.can_answer_ticket(ticket_id));
create policy "Both sides can write in their enquiry" on public.ticket_messages
  for insert to authenticated with check (public.owns_ticket(ticket_id) or public.can_answer_ticket(ticket_id));

-- ==== 2. the Kidscover Standard admission form ============================================================================
create or replace function public.admission_classes()
 returns text[]
 language sql
 immutable
 set search_path = ''
as $$
  select array['playgroup', 'nursery', 'jr_kg', 'sr_kg', 'class_1', 'class_2', 'class_3', 'class_4', 'class_5', 'class_6',
               'class_7', 'class_8', 'class_9', 'class_10', 'class_11', 'class_12'];
$$;

create table if not exists public.admission_applications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  parent_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'submitted'
    check (status in ('submitted', 'in_review', 'visit_scheduled', 'offered', 'waitlisted', 'accepted', 'declined', 'withdrawn')),
  status_note text check (status_note is null or char_length(status_note) between 1 and 500),
  child_first_name text not null check (char_length(btrim(child_first_name)) between 1 and 60),
  child_last_name text not null check (char_length(btrim(child_last_name)) between 1 and 60),
  child_dob date not null,
  child_gender text check (child_gender is null or child_gender in ('girl', 'boy', 'other')),
  class_applying text not null check (class_applying = any (public.admission_classes())),
  academic_year text not null check (academic_year ~ '^20[0-9]{2}-[0-9]{2}$'),
  current_school text check (current_school is null or char_length(current_school) between 1 and 120),
  parent_name text not null check (char_length(btrim(parent_name)) between 2 and 120),
  parent_relation text not null check (parent_relation in ('mother', 'father', 'guardian')),
  parent_phone text not null check (parent_phone ~ '^\+?[0-9]{10,15}$'),
  parent_email text not null check (char_length(parent_email) <= 254 and parent_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address text not null check (char_length(btrim(address)) between 5 and 300),
  pincode text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  notes text check (notes is null or char_length(notes) between 1 and 1000),
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists admission_applications_school_idx on public.admission_applications (school_id, created_at desc);
create index if not exists admission_applications_parent_idx on public.admission_applications (parent_id, created_at desc);
-- the same child cannot have two live applications to one school
create unique index if not exists admission_applications_one_live
  on public.admission_applications (school_id, parent_id, lower(btrim(child_first_name)), child_dob)
  where status not in ('withdrawn', 'declined');

create table if not exists public.admission_application_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.admission_applications (id) on delete cascade,
  status text not null,
  note text,
  by_role text not null check (by_role in ('parent', 'school', 'kidscover')),
  at timestamptz not null default now()
);
create index if not exists admission_application_events_app_idx on public.admission_application_events (application_id, at);

create or replace function public.can_see_application(p_app uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.admission_applications a
                  where a.id = p_app and (a.parent_id = auth.uid() or public.is_school_staff(a.school_id) or public.is_admin()));
$$;

-- who is acting, in the words the events use
create or replace function public.actor_role(p_school uuid)
 returns text
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select case when public.is_admin() then 'kidscover' when public.is_school_staff(p_school) then 'school' else 'parent' end;
$$;

-- p_form: { child_first_name, child_last_name, child_dob "YYYY-MM-DD", child_gender (girl|boy|other|null),
--   class_applying (see admission_classes), academic_year "2027-28", current_school, parent_name,
--   parent_relation (mother|father|guardian), parent_phone, parent_email, address, pincode, notes, consent (true) }
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
  if exists (select 1 from jsonb_object_keys(p_form) k
              where k not in ('child_first_name', 'child_last_name', 'child_dob', 'child_gender', 'class_applying', 'academic_year',
                              'current_school', 'parent_name', 'parent_relation', 'parent_phone', 'parent_email', 'address',
                              'pincode', 'notes', 'consent')) then
    raise exception 'Unknown field in the form' using errcode = '22023';
  end if;
  begin
    insert into public.admission_applications (school_id, parent_id, child_first_name, child_last_name, child_dob, child_gender,
                                               class_applying, academic_year, current_school, parent_name, parent_relation,
                                               parent_phone, parent_email, address, pincode, notes, consent_at)
    values (p_school, auth.uid(), btrim(p_form->>'child_first_name'), btrim(p_form->>'child_last_name'), v_dob, v_gender,
            p_form->>'class_applying', v_year, nullif(btrim(coalesce(p_form->>'current_school', '')), ''),
            btrim(p_form->>'parent_name'), p_form->>'parent_relation', v_phone, v_email, btrim(p_form->>'address'),
            btrim(p_form->>'pincode'), nullif(btrim(coalesce(p_form->>'notes', '')), ''), now())
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'You have already applied to this school for this child' using errcode = '23505';
    when check_violation or not_null_violation then
      raise exception 'Please check the form: a name, the address or a note is missing or too long' using errcode = '22023';
  end;
  return v_id;
end;
$$;

create or replace function public.withdraw_admission_application(p_app uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  update public.admission_applications set status = 'withdrawn', updated_at = now()
   where id = p_app and parent_id = auth.uid() and status <> 'withdrawn';
  if not found then
    raise exception 'This application is not yours, or was already withdrawn' using errcode = '42501';
  end if;
end;
$$;

-- The parent can remove an application completely (their right to have their data erased). A copy the school already
-- received in its own system is the school's to delete.
create or replace function public.delete_admission_application(p_app uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  delete from public.admission_applications where id = p_app and parent_id = auth.uid();
  if not found then
    raise exception 'This application is not yours' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.set_admission_status(p_app uuid, p_status text, p_note text default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_school uuid;
  v_status text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select school_id, status into v_school, v_status from public.admission_applications where id = p_app for update;
  if v_school is null or not (public.is_admin() or public.is_school_staff(v_school)) then
    raise exception 'You can only update applications to your own school' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('in_review', 'visit_scheduled', 'offered', 'waitlisted', 'accepted', 'declined') then
    raise exception 'Unknown stage' using errcode = '22023';
  end if;
  if v_status = 'withdrawn' then
    raise exception 'The family withdrew this application' using errcode = '22023';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'Keep the note to the family under 500 characters' using errcode = '22023';
  end if;
  update public.admission_applications set status = p_status, status_note = v_note, updated_at = now() where id = p_app;
end;
$$;

-- every stage the application goes through, for the parent's timeline
create or replace function public.admission_application_event()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.status_note is distinct from old.status_note then
    insert into public.admission_application_events (application_id, status, note, by_role)
    values (new.id, new.status, new.status_note, case when tg_op = 'INSERT' then 'parent' else public.actor_role(new.school_id) end);
  end if;
  return null;
end;
$$;
drop trigger if exists admission_application_event on public.admission_applications;
create trigger admission_application_event after insert or update on public.admission_applications
  for each row execute function public.admission_application_event();

-- ==== 3. the CRM webhook ===================================================================================================
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.crm_secrets (
  school_id uuid primary key references public.schools (id) on delete cascade,
  secret text not null check (secret ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
revoke all on private.crm_secrets from public, anon, authenticated;

-- An address a school's system listens on: https only, a real host name (no IP address, no local or internal name),
-- the standard port, no user name or password in it.
create or replace function public.valid_webhook_url(p_url text)
 returns boolean
 language sql
 immutable
 set search_path = ''
as $$
  select p_url is not null
     and char_length(p_url) <= 500
     and p_url ~* '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:443)?(/[^[:space:]]*)?$'
     and p_url !~* '^https://[^/]*\.(local|localhost|internal|intranet|lan|home|corp|arpa)(:443)?(/|$)'
     and p_url !~* '^https://[^/]*(supabase\.co|supabase\.in)(:443)?(/|$)';
$$;

create table if not exists public.school_crm_webhooks (
  school_id uuid primary key references public.schools (id) on delete cascade,
  url text not null check (public.valid_webhook_url(url)),
  enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text
);

create table if not exists public.crm_deliveries (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  application_id uuid references public.admission_applications (id) on delete cascade,
  event text not null check (event in ('application.submitted', 'application.withdrawn', 'webhook.test')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  http_status int,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists crm_deliveries_due_idx on public.crm_deliveries (status, next_attempt_at);
create index if not exists crm_deliveries_school_idx on public.crm_deliveries (school_id, created_at desc);

create or replace function public.new_crm_secret()
 returns text
 language sql
 volatile
 set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Connects (or changes) a school's CRM address. Returns the signing secret when a new one is made (the first time), so
-- the admin can pass it to the school; after that it returns null and the secret stays hidden.
create or replace function public.set_crm_webhook(p_school uuid, p_url text, p_enabled boolean default true)
 returns text
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_secret text;
  v_url text := btrim(coalesce(p_url, ''));
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can connect a school''s admissions system' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools where id = p_school) then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
  if not public.valid_webhook_url(v_url) then
    raise exception 'Use the https address of the school''s admissions system (a web address, not an IP address)' using errcode = '22023';
  end if;
  insert into public.school_crm_webhooks (school_id, url, enabled, updated_by, updated_at)
  values (p_school, v_url, coalesce(p_enabled, true), auth.uid(), now())
  on conflict (school_id) do update set url = excluded.url, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  if not exists (select 1 from private.crm_secrets where school_id = p_school) then
    v_secret := public.new_crm_secret();
    insert into private.crm_secrets (school_id, secret) values (p_school, v_secret);
  end if;
  return v_secret;
end;
$$;

create or replace function public.rotate_crm_secret(p_school uuid)
 returns text
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_secret text := public.new_crm_secret();
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can change the signing secret' using errcode = '42501';
  end if;
  if not exists (select 1 from public.school_crm_webhooks where school_id = p_school) then
    raise exception 'This school has no admissions system connected' using errcode = 'P0002';
  end if;
  insert into private.crm_secrets (school_id, secret) values (p_school, v_secret)
  on conflict (school_id) do update set secret = excluded.secret, created_at = now();
  return v_secret;
end;
$$;

create or replace function public.remove_crm_webhook(p_school uuid)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can disconnect a school''s admissions system' using errcode = '42501';
  end if;
  delete from public.crm_deliveries where school_id = p_school and status in ('pending', 'sending');
  delete from public.school_crm_webhooks where school_id = p_school;
  delete from private.crm_secrets where school_id = p_school;
end;
$$;

create or replace function public.queue_crm_test(p_school uuid)
 returns bigint
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can send a test' using errcode = '42501';
  end if;
  if not exists (select 1 from public.school_crm_webhooks where school_id = p_school) then
    raise exception 'This school has no admissions system connected' using errcode = 'P0002';
  end if;
  insert into public.crm_deliveries (school_id, event) values (p_school, 'webhook.test') returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.retry_crm_delivery(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_school uuid;
begin
  select school_id into v_school from public.crm_deliveries where id = p_id;
  if v_school is null or not (public.is_admin() or public.is_school_staff(v_school)) then
    raise exception 'You can only retry deliveries to your own school' using errcode = '42501';
  end if;
  update public.crm_deliveries set status = 'pending', next_attempt_at = now(), attempts = 0
   where id = p_id and status = 'failed';
  if not found then
    raise exception 'Only a failed delivery can be retried' using errcode = '22023';
  end if;
end;
$$;

-- A new application (or a withdrawal) queues a delivery if the school's system is connected and switched on.
create or replace function public.queue_crm_delivery()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'application.submitted';
  elsif new.status = 'withdrawn' and old.status is distinct from 'withdrawn' then
    v_event := 'application.withdrawn';
  else
    return null;
  end if;
  if exists (select 1 from public.school_crm_webhooks w where w.school_id = new.school_id and w.enabled) then
    insert into public.crm_deliveries (school_id, application_id, event) values (new.school_id, new.id, v_event);
  end if;
  return null;
end;
$$;
drop trigger if exists admission_application_crm on public.admission_applications;
create trigger admission_application_crm after insert or update of status on public.admission_applications
  for each row execute function public.queue_crm_delivery();

-- For the crm-deliver edge function only (the service role): takes up to p_limit due deliveries, marks them as being
-- sent, and hands over what to send. A delivery stuck "sending" for 10 minutes (a crashed run) is taken again.
create or replace function public.claim_crm_deliveries(p_limit int default 20)
 returns table (delivery_id bigint, event text, url text, secret text, payload jsonb)
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id from public.crm_deliveries d
     join public.school_crm_webhooks w on w.school_id = d.school_id and w.enabled
     where (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.next_attempt_at <= now() - interval '10 minutes')
     order by d.id
     limit greatest(1, least(coalesce(p_limit, 20), 50))
     for update of d skip locked
  ), taken as (
    update public.crm_deliveries d
       set status = 'sending', attempts = d.attempts + 1, next_attempt_at = now()
      from due where d.id = due.id
    returning d.id, d.school_id, d.application_id, d.event
  )
  select t.id, t.event, w.url, s.secret,
         jsonb_build_object(
           'event', t.event,
           'delivery_id', t.id,
           'sent_at', now(),
           'school', jsonb_build_object('id', sc.id, 'name', sc.name),
           'application', case when a.id is null then null else jsonb_build_object(
             'id', a.id, 'status', a.status, 'submitted_at', a.created_at,
             'child', jsonb_build_object('first_name', a.child_first_name, 'last_name', a.child_last_name,
                                         'date_of_birth', a.child_dob, 'gender', a.child_gender),
             'class_applying', a.class_applying, 'academic_year', a.academic_year, 'current_school', a.current_school,
             'parent', jsonb_build_object('name', a.parent_name, 'relation', a.parent_relation, 'phone', a.parent_phone,
                                          'email', a.parent_email),
             'address', jsonb_build_object('text', a.address, 'pincode', a.pincode),
             'notes', a.notes, 'consent_at', a.consent_at) end)
    from taken t
    join public.school_crm_webhooks w on w.school_id = t.school_id
    join private.crm_secrets s on s.school_id = t.school_id
    join public.schools sc on sc.id = t.school_id
    left join public.admission_applications a on a.id = t.application_id;
end;
$$;

-- For the crm-deliver edge function only: records how a delivery went. Failures are tried again after 1 minute,
-- 5 minutes, 30 minutes, 2 hours and 12 hours, then marked failed (an admin or the school can retry).
create or replace function public.finish_crm_delivery(p_id bigint, p_ok boolean, p_http_status int default null, p_error text default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  d public.crm_deliveries;
begin
  select * into d from public.crm_deliveries where id = p_id for update;
  if not found then return; end if;
  if p_ok then
    update public.crm_deliveries set status = 'delivered', delivered_at = now(), http_status = p_http_status, last_error = null where id = p_id;
    update public.school_crm_webhooks set last_success_at = now() where school_id = d.school_id;
  else
    update public.crm_deliveries
       set status = case when d.attempts >= 6 then 'failed' else 'pending' end,
           next_attempt_at = now() + case d.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                                     when 3 then interval '30 minutes' when 4 then interval '2 hours'
                                                     else interval '12 hours' end,
           http_status = p_http_status, last_error = left(coalesce(p_error, 'failed'), 300)
     where id = p_id;
    update public.school_crm_webhooks set last_failure_at = now(), last_error = left(coalesce(p_error, 'failed'), 300)
     where school_id = d.school_id;
  end if;
end;
$$;

-- ==== 4. going out to a school's own pages ===================================================================================
create table if not exists public.outbound_clicks (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in ('website', 'admission_page', 'fee_page', 'directions')),
  created_at timestamptz not null default now()
);
create index if not exists outbound_clicks_school_idx on public.outbound_clicks (school_id, created_at desc);
create index if not exists outbound_clicks_user_idx on public.outbound_clicks (user_id, school_id, kind, created_at desc);

-- One click per parent, school and kind every 30 minutes counts (tapping twice is not two visits).
create or replace function public.log_outbound_click(p_school uuid, p_kind text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if p_kind is null or p_kind not in ('website', 'admission_page', 'fee_page', 'directions') then
    raise exception 'Unknown kind of link' using errcode = '22023';
  end if;
  if not exists (select 1 from public.schools s where s.id = p_school and not s.is_hidden) then
    return;
  end if;
  if exists (select 1 from public.outbound_clicks c where c.user_id = auth.uid() and c.school_id = p_school
                and c.kind = p_kind and c.created_at > now() - interval '30 minutes') then
    return;
  end if;
  insert into public.outbound_clicks (school_id, user_id, kind) values (p_school, auth.uid(), p_kind);
end;
$$;

-- Counts for the portal: a school's staff see their own schools, Kidscover admins any (or all with p_school null).
create or replace function public.outbound_click_stats(p_school uuid default null, p_days int default 30)
 returns table (school_id uuid, school_name text, kind text, clicks bigint, people bigint)
 language plpgsql
 stable
 security definer
 set search_path = ''
as $$
begin
  if not public.is_admin() and (p_school is null or not public.is_school_staff(p_school)) then
    raise exception 'You can only see your own school''s numbers' using errcode = '42501';
  end if;
  return query
    select c.school_id, s.name, c.kind, count(*), count(distinct c.user_id)
      from public.outbound_clicks c join public.schools s on s.id = c.school_id
     where (p_school is null or c.school_id = p_school)
       and c.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)))
     group by c.school_id, s.name, c.kind
     order by count(*) desc
     limit 500;
end;
$$;

-- ==== who can read and call what ===========================================================================================
alter table public.admission_applications enable row level security;
alter table public.admission_application_events enable row level security;
alter table public.school_crm_webhooks enable row level security;
alter table public.crm_deliveries enable row level security;
alter table public.outbound_clicks enable row level security;

drop policy if exists "Applications: the parent, the school and Kidscover" on public.admission_applications;
create policy "Applications: the parent, the school and Kidscover" on public.admission_applications
  for select to authenticated using (parent_id = auth.uid() or public.is_school_staff(school_id) or public.is_admin());
drop policy if exists "Application stages: whoever can see the application" on public.admission_application_events;
create policy "Application stages: whoever can see the application" on public.admission_application_events
  for select to authenticated using (public.can_see_application(application_id));
drop policy if exists "CRM connection: the school and Kidscover" on public.school_crm_webhooks;
create policy "CRM connection: the school and Kidscover" on public.school_crm_webhooks
  for select to authenticated using (public.is_school_staff(school_id) or public.is_admin());
drop policy if exists "CRM deliveries: the school and Kidscover" on public.crm_deliveries;
create policy "CRM deliveries: the school and Kidscover" on public.crm_deliveries
  for select to authenticated using (public.is_school_staff(school_id) or public.is_admin());
drop policy if exists "Clicks: Kidscover admins" on public.outbound_clicks;
create policy "Clicks: Kidscover admins" on public.outbound_clicks
  for select to authenticated using (public.is_admin());

revoke all on public.admission_applications, public.admission_application_events, public.school_crm_webhooks,
  public.crm_deliveries, public.outbound_clicks from anon, authenticated;
grant select on public.admission_applications, public.admission_application_events, public.school_crm_webhooks,
  public.crm_deliveries, public.outbound_clicks to authenticated;

-- the old applications table (before the standard form): parents could write any status into it. Read-only now.
revoke insert, update, delete on public.applications from anon, authenticated;
drop policy if exists "Parents can insert own applications" on public.applications;
drop policy if exists "Admins can update applications" on public.applications;

-- Supabase's default privileges give anon EXECUTE on new functions, so anon is named as well as PUBLIC.
revoke execute on function public.is_school_staff(uuid), public.can_answer_ticket(uuid), public.admission_classes(),
  public.can_see_application(uuid), public.actor_role(uuid), public.submit_admission_application(uuid, jsonb),
  public.withdraw_admission_application(uuid), public.delete_admission_application(uuid),
  public.set_admission_status(uuid, text, text), public.admission_application_event(), public.valid_webhook_url(text),
  public.new_crm_secret(), public.set_crm_webhook(uuid, text, boolean), public.rotate_crm_secret(uuid),
  public.remove_crm_webhook(uuid), public.queue_crm_test(uuid), public.retry_crm_delivery(bigint),
  public.queue_crm_delivery(), public.claim_crm_deliveries(int), public.finish_crm_delivery(bigint, boolean, int, text),
  public.log_outbound_click(uuid, text), public.outbound_click_stats(uuid, int)
  from public, anon;
grant execute on function public.is_school_staff(uuid), public.can_answer_ticket(uuid), public.admission_classes(),
  public.can_see_application(uuid), public.submit_admission_application(uuid, jsonb),
  public.withdraw_admission_application(uuid), public.delete_admission_application(uuid),
  public.set_admission_status(uuid, text, text), public.valid_webhook_url(text), public.set_crm_webhook(uuid, text, boolean),
  public.rotate_crm_secret(uuid), public.remove_crm_webhook(uuid), public.queue_crm_test(uuid),
  public.retry_crm_delivery(bigint), public.log_outbound_click(uuid, text), public.outbound_click_stats(uuid, int)
  to authenticated;
-- the delivery queue is worked by the edge function alone
revoke execute on function public.claim_crm_deliveries(int), public.finish_crm_delivery(bigint, boolean, int, text) from authenticated;
grant execute on function public.claim_crm_deliveries(int), public.finish_crm_delivery(bigint, boolean, int, text) to service_role;
grant usage on schema private to service_role;
grant select on private.crm_secrets to service_role;

notify pgrst, 'reload schema';
