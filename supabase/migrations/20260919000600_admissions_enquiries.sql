-- Admissions enquiries and the conversation that follows. Safe to run more than once.
--
-- A parent asks a school about joining (which class, roughly when, and a message). Kidscover staff answer from the
-- Partner Portal; the parent reads the answer in the app and can write back.
--
-- The thread is public.tickets and the messages are public.ticket_messages. Both tables already existed, but:
--   * ticket_messages had row level security switched on with NO policies, so nobody except the service role could
--     read or write a single message;
--   * the Partner Portal wrote a column (admin_reply) and a status ('answered') that do not exist, so replying
--     always failed.
-- This file makes the conversation work end to end.
--
-- On purpose, an enquiry does NOT collect a child's name or date of birth. A class and a rough start year are enough
-- to begin a conversation, and a school can ask for the rest once it is talking to the family. Less data about a
-- child, less to protect.
--
-- Who may do what:
--   * a parent with a confirmed email or phone may open an enquiry: at most 10 a day, and only one open enquiry per
--     school at a time (the existing thread is the place to continue);
--   * both sides may write in a thread they are part of, at most 60 messages an hour; a reply reopens a closed thread;
--   * a thread is visible only to its parent and to Kidscover admins.
-- Scoping to a school's own admissions staff needs a school_members table, which does not exist yet. When it does,
-- add it to owns_ticket() and to the two "Admins" policies below; nothing else here has to change.
--
-- Status: 'open' = waiting for Kidscover, 'replied' = waiting for the parent, 'closed' = finished. The status is set
-- by the message trigger and by set_ticket_status(), never written directly by either app.

-- ---- columns ----------------------------------------------------------------------------------------------------
alter table public.tickets
  add column if not exists grade_of_interest text,
  add column if not exists start_year integer,
  add column if not exists last_message_at timestamptz not null default now(),
  add column if not exists parent_read_at timestamptz,
  add column if not exists staff_read_at timestamptz;

-- so a parent never has to send their own id, and cannot send someone else's
alter table public.tickets alter column parent_id set default auth.uid();
alter table public.ticket_messages alter column sender_id set default auth.uid();

-- Length limits. The ones on columns that already held data are added NOT VALID: they apply to everything written
-- from now on, and no old row can block this migration.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.tickets'::regclass and conname = 'tickets_subject_len') then
    alter table public.tickets add constraint tickets_subject_len check (char_length(btrim(subject)) between 1 and 120) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tickets'::regclass and conname = 'tickets_grade_len') then
    alter table public.tickets add constraint tickets_grade_len check (grade_of_interest is null or char_length(btrim(grade_of_interest)) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tickets'::regclass and conname = 'tickets_start_year_range') then
    alter table public.tickets add constraint tickets_start_year_range check (start_year is null or start_year between 2020 and 2100);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.ticket_messages'::regclass and conname = 'ticket_messages_len') then
    alter table public.ticket_messages add constraint ticket_messages_len check (char_length(btrim(message)) between 1 and 4000) not valid;
  end if;
end $$;

create index if not exists tickets_parent_idx on public.tickets (parent_id, last_message_at desc);
create index if not exists tickets_status_idx on public.tickets (status, last_message_at desc);
create index if not exists tickets_school_idx on public.tickets (school_id, last_message_at desc);
create index if not exists ticket_messages_thread_idx on public.ticket_messages (ticket_id, created_at);

-- ---- helper used by the policies ---------------------------------------------------------------------------------
create or replace function public.owns_ticket(p_ticket uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.tickets t where t.id = p_ticket and t.parent_id = auth.uid());
$$;
-- Supabase's default privileges hand EXECUTE on every new function to anon as well, so revoking from PUBLIC is not
-- enough on its own: anon has to be named. Signed-out visitors have no business in anybody's enquiries.
revoke execute on function public.owns_ticket(uuid) from public, anon;
grant execute on function public.owns_ticket(uuid) to authenticated;

-- ---- triggers ----------------------------------------------------------------------------------------------------
create or replace function public.ticket_before_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to send an enquiry' using errcode = '42501';
  end if;
  if not public.is_admin() then
    new.parent_id := auth.uid();   -- whatever the client sent
    if not public.is_verified_user() then
      raise exception 'confirm your email address first' using errcode = '42501';
    end if;
    if (select count(*) from public.tickets t
        where t.parent_id = auth.uid() and t.created_at > now() - interval '24 hours') >= 10 then
      raise exception 'daily enquiry limit reached' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.tickets t
               where t.parent_id = auth.uid() and t.school_id = new.school_id and t.status <> 'closed') then
      raise exception 'an enquiry with this school is already open' using errcode = 'P0001';
    end if;
  end if;
  new.status := 'open';            -- a new enquiry always waits for an answer
  new.last_message_at := now();
  return new;
end;
$$;
drop trigger if exists ticket_before_insert on public.tickets;
create trigger ticket_before_insert before insert on public.tickets
  for each row execute function public.ticket_before_insert();

create or replace function public.ticket_message_before_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'sign in to send a message' using errcode = '42501';
  end if;
  if not v_admin and not public.owns_ticket(new.ticket_id) then
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
  if not v_admin and not public.is_verified_user() then
    raise exception 'confirm your email address first' using errcode = '42501';
  end if;
  if (select count(*) from public.ticket_messages m
      where m.sender_id = auth.uid() and m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many messages just now, please wait a little' using errcode = 'P0001';
  end if;
  new.sender_id := auth.uid();     -- nobody writes in someone else's name
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists ticket_message_before_insert on public.ticket_messages;
create trigger ticket_message_before_insert before insert on public.ticket_messages
  for each row execute function public.ticket_message_before_insert();

-- The thread follows its last message: who is waiting, when it last moved, and the sender has by definition read it.
create or replace function public.ticket_message_after_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_from_staff boolean;
begin
  select t.parent_id is distinct from new.sender_id into v_from_staff
    from public.tickets t where t.id = new.ticket_id;
  update public.tickets
     set last_message_at = new.created_at,
         status = case when v_from_staff then 'replied' else 'open' end,
         staff_read_at = case when v_from_staff then new.created_at else staff_read_at end,
         parent_read_at = case when v_from_staff then parent_read_at else new.created_at end
   where id = new.ticket_id;
  return new;
end;
$$;
drop trigger if exists ticket_message_after_insert on public.ticket_messages;
create trigger ticket_message_after_insert after insert on public.ticket_messages
  for each row execute function public.ticket_message_after_insert();

-- ---- what the apps call -------------------------------------------------------------------------------------------
-- One enquiry and its first message, together: a half-made thread with nothing in it cannot happen.
-- Runs as the caller, so every rule above still applies.
create or replace function public.send_enquiry(p_school uuid, p_subject text, p_message text,
                                               p_grade text default null, p_start_year integer default null)
 returns uuid
 language plpgsql
 security invoker
 set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.tickets (school_id, subject, grade_of_interest, start_year)
    values (p_school, btrim(p_subject), nullif(btrim(coalesce(p_grade, '')), ''), p_start_year)
    returning id into v_id;
  insert into public.ticket_messages (ticket_id, message) values (v_id, btrim(p_message));
  return v_id;
end;
$$;

create or replace function public.set_ticket_status(p_ticket uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not (public.is_admin() or public.owns_ticket(p_ticket)) then
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
  if p_status not in ('open', 'replied', 'closed') then
    raise exception 'unknown status %', p_status;
  end if;
  update public.tickets set status = p_status where id = p_ticket;
  if not found then
    raise exception 'enquiry not found';
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
  elsif public.is_admin() then
    update public.tickets set staff_read_at = now() where id = p_ticket;
  else
    raise exception 'this enquiry is not yours' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.send_enquiry(uuid, text, text, text, integer),
                          public.set_ticket_status(uuid, text),
                          public.mark_ticket_read(uuid) from public, anon;
grant execute on function public.send_enquiry(uuid, text, text, text, integer),
                         public.set_ticket_status(uuid, text),
                         public.mark_ticket_read(uuid) to authenticated;

-- ---- row level security --------------------------------------------------------------------------------------------
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;

drop policy if exists "Allow users to view own tickets" on public.tickets;
drop policy if exists "Allow authenticated insert into tickets" on public.tickets;
drop policy if exists "Admins can view and reply to all tickets" on public.tickets;
drop policy if exists "Parents see their own enquiries" on public.tickets;
drop policy if exists "Admins see every enquiry" on public.tickets;
drop policy if exists "Parents can open an enquiry" on public.tickets;
create policy "Parents see their own enquiries" on public.tickets
  for select to authenticated using (parent_id = auth.uid());
create policy "Admins see every enquiry" on public.tickets
  for select to authenticated using (public.is_admin());
create policy "Parents can open an enquiry" on public.tickets
  for insert to authenticated with check (parent_id = auth.uid() or public.is_admin());
-- no update or delete policy on purpose: the status and the read marks move only through the functions above

drop policy if exists "Both sides read the messages of their enquiry" on public.ticket_messages;
drop policy if exists "Both sides can write in their enquiry" on public.ticket_messages;
create policy "Both sides read the messages of their enquiry" on public.ticket_messages
  for select to authenticated using (public.owns_ticket(ticket_id) or public.is_admin());
create policy "Both sides can write in their enquiry" on public.ticket_messages
  for insert to authenticated with check (public.owns_ticket(ticket_id) or public.is_admin());

-- ---- privileges: only what each side needs ---------------------------------------------------------------------------
revoke all on public.tickets, public.ticket_messages from anon, authenticated;
grant select on public.tickets to authenticated;
grant insert (school_id, subject, grade_of_interest, start_year) on public.tickets to authenticated;
grant select on public.ticket_messages to authenticated;
grant insert (ticket_id, message) on public.ticket_messages to authenticated;

-- ---- the older tickets, and the inbox ---------------------------------------------------------------------------------
-- Threads made before this file kept their first message in tickets.message. Move a copy into the conversation so
-- every thread reads the same way. (The triggers are off for this one statement: it runs as the migration, not as a
-- signed-in parent.) tickets.message itself is left alone as a record of what was there.
alter table public.ticket_messages disable trigger user;
insert into public.ticket_messages (ticket_id, sender_id, message, created_at)
  select t.id, t.parent_id, btrim(t.message), t.created_at
    from public.tickets t
   where coalesce(btrim(t.message), '') <> ''
     and not exists (select 1 from public.ticket_messages m where m.ticket_id = t.id);
alter table public.ticket_messages enable trigger user;

update public.tickets t
   set last_message_at = greatest(t.created_at,
         coalesce((select max(m.created_at) from public.ticket_messages m where m.ticket_id = t.id), t.created_at));

-- One row per enquiry with everything a list needs, so neither app has to guess at a join. It runs as the caller, so a
-- parent sees only their own threads and an admin sees all of them. The school is joined loosely: a school that gets
-- hidden later must not make a parent's conversation disappear.
drop view if exists public.enquiry_threads;
create view public.enquiry_threads with (security_invoker = true) as
  select t.id,
         t.school_id,
         s.name as school_name,
         t.parent_id,
         p.first_name as parent_first_name,
         p.last_name as parent_last_name,
         p.email as parent_email,
         t.subject,
         t.grade_of_interest,
         t.start_year,
         t.status,
         t.created_at,
         t.last_message_at,
         t.parent_read_at,
         t.staff_read_at,
         (select count(*) from public.ticket_messages m where m.ticket_id = t.id)::int as message_count,
         (select m.message from public.ticket_messages m where m.ticket_id = t.id
           order by m.created_at desc, m.id desc limit 1) as last_message,
         (t.last_message_at > coalesce(t.parent_read_at, '-infinity'::timestamptz)) as unread_for_parent,
         (t.last_message_at > coalesce(t.staff_read_at, '-infinity'::timestamptz)) as unread_for_staff
    from public.tickets t
    left join public.schools s on s.id = t.school_id
    left join public.profiles p on p.id = t.parent_id;
grant select on public.enquiry_threads to authenticated;

-- make the new functions and view visible to the API straight away
notify pgrst, 'reload schema';
