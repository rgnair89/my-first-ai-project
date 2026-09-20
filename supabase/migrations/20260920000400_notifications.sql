-- supabase/migrations/20260920000400_notifications.sql
--
-- Push notifications to a parent's phone: a school answered their enquiry, or moved their application along.
--
--   push_devices    the Expo push token of each phone a parent signed in on. One person can have several.
--   notifications   one row per thing worth telling someone about. Triggers write them; nothing is written by hand.
--                   On purpose they carry NO message text: a notification says "the school replied", never what was
--                   said, so nothing private shows on a locked screen. The app shows the real words.
--
-- The send-push edge function takes a batch (claim_push_batch), sends it through Expo's push service in the person's
-- own language, and reports back (finish_push / forget_push_token). Only the service role may do that.
--
-- Needs 20260920000300 first. Safe to run more than once.

create table if not exists public.push_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique check (token ~ '^(ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]|ExpoPushToken\[[A-Za-z0-9_-]{1,64}\])$'),
  platform text not null check (platform in ('android', 'ios', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('enquiry_reply', 'application_status')),
  school_id uuid references public.schools (id) on delete cascade,
  ticket_id uuid references public.tickets (id) on delete cascade,
  application_id uuid references public.admission_applications (id) on delete cascade,
  status text check (status is null or char_length(status) <= 40),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_sent_at timestamptz,
  push_attempts int not null default 0
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_pending_idx on public.notifications (push_sent_at, push_attempts) where push_sent_at is null;

-- ---- the phone signs in ---------------------------------------------------------------------------------------------
create or replace function public.register_push_device(p_token text, p_platform text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^(ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]|ExpoPushToken\[[A-Za-z0-9_-]{1,64}\])$' then
    raise exception 'That is not an Expo push token' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('android', 'ios', 'web') then
    raise exception 'Unknown kind of device' using errcode = '22023';
  end if;
  -- at most 10 phones per person: the oldest makes way
  delete from public.push_devices d
   where d.user_id = auth.uid()
     and d.id not in (select id from public.push_devices where user_id = auth.uid() order by last_seen_at desc limit 9);
  insert into public.push_devices (user_id, token, platform) values (auth.uid(), p_token, p_platform)
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, last_seen_at = now();
end;
$$;

create or replace function public.unregister_push_device(p_token text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  delete from public.push_devices where token = p_token and user_id = auth.uid();
end;
$$;

-- ---- what is worth telling someone ------------------------------------------------------------------------------------
create or replace function public.notify_enquiry_reply()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_parent uuid;
  v_school uuid;
begin
  if new.sender_role = 'parent' then
    return null;
  end if;
  select t.parent_id, t.school_id into v_parent, v_school from public.tickets t where t.id = new.ticket_id;
  if v_parent is null or v_parent = new.sender_id then
    return null;
  end if;
  insert into public.notifications (user_id, kind, school_id, ticket_id) values (v_parent, 'enquiry_reply', v_school, new.ticket_id);
  return null;
end;
$$;
drop trigger if exists ticket_message_notify on public.ticket_messages;
create trigger ticket_message_notify after insert on public.ticket_messages
  for each row execute function public.notify_enquiry_reply();

create or replace function public.notify_application_status()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if new.status is not distinct from old.status or new.status = 'withdrawn' or new.parent_id = auth.uid() then
    return null;   -- nothing changed, or the family did it themselves
  end if;
  insert into public.notifications (user_id, kind, school_id, application_id, status)
  values (new.parent_id, 'application_status', new.school_id, new.id, new.status);
  return null;
end;
$$;
drop trigger if exists admission_application_notify on public.admission_applications;
create trigger admission_application_notify after update of status on public.admission_applications
  for each row execute function public.notify_application_status();

-- ---- the app ------------------------------------------------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids bigint[] default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
end;
$$;

-- ---- the send-push edge function (the service role only) -----------------------------------------------------------------
-- Takes up to p_limit notifications that have not been pushed yet and hands over one row per phone to send to, with the
-- person's language. Marks them as tried, so a second run does not send them twice.
create or replace function public.claim_push_batch(p_limit int default 100)
 returns table (notification_id bigint, token text, platform text, language text, kind text, status text, school_name text)
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  return query
  with due as (
    select n.id from public.notifications n
     where n.push_sent_at is null and n.push_attempts < 3
       and exists (select 1 from public.push_devices d join public.profiles p on p.id = d.user_id
                    where d.user_id = n.user_id and p.notify_push)
     order by n.id
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update of n skip locked
  ), taken as (
    update public.notifications n set push_attempts = n.push_attempts + 1
      from due where n.id = due.id
    returning n.id, n.user_id, n.kind, n.status, n.school_id
  )
  select t.id, d.token, d.platform, coalesce(p.language, 'en'), t.kind, t.status, s.name
    from taken t
    join public.push_devices d on d.user_id = t.user_id
    join public.profiles p on p.id = t.user_id and p.notify_push
    left join public.schools s on s.id = t.school_id;
end;
$$;

create or replace function public.finish_push(p_ids bigint[])
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  update public.notifications set push_sent_at = now() where id = any (coalesce(p_ids, array[]::bigint[]));
end;
$$;

-- Expo says a token no longer works (the app was removed): forget that phone.
create or replace function public.forget_push_token(p_token text)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  delete from public.push_devices where token = p_token;
end;
$$;

-- Old notifications are not kept: they are only a nudge, and the app holds the real thing.
create or replace function public.purge_old_notifications(p_days int default 90)
 returns integer
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.notifications where created_at < now() - make_interval(days => greatest(7, least(coalesce(p_days, 90), 3650)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---- who can read and call what ---------------------------------------------------------------------------------------
alter table public.push_devices enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "People see their own phones" on public.push_devices;
create policy "People see their own phones" on public.push_devices
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "People forget their own phones" on public.push_devices;
create policy "People forget their own phones" on public.push_devices
  for delete to authenticated using (user_id = auth.uid());
drop policy if exists "People see their own notifications" on public.notifications;
create policy "People see their own notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid());

revoke all on public.push_devices, public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant select, delete on public.push_devices to authenticated;

revoke execute on function public.register_push_device(text, text), public.unregister_push_device(text),
  public.mark_notifications_read(bigint[]), public.claim_push_batch(int), public.finish_push(bigint[]),
  public.forget_push_token(text), public.purge_old_notifications(int), public.notify_enquiry_reply(),
  public.notify_application_status() from public, anon, authenticated;
grant execute on function public.register_push_device(text, text), public.unregister_push_device(text),
  public.mark_notifications_read(bigint[]) to authenticated;
grant execute on function public.claim_push_batch(int), public.finish_push(bigint[]), public.forget_push_token(text),
  public.purge_old_notifications(int) to service_role;

notify pgrst, 'reload schema';
