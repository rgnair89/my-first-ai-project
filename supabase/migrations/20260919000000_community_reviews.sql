-- Community reviews: parents review schools.
--   * Anonymous to everyone else: the public table has no author column at all. Who wrote what lives in a
--     separate private table that only the author and admins can read.
--   * Verified accounts only (a confirmed email or phone).
--   * One review per parent per school, and at most 10 new reviews per parent per 24 hours.
--   * Moderated before publishing: new reviews start 'pending'. Editing a published review sends it back to pending.
--   * A report button: three open reports from different parents put a published review back in the queue.
-- Moderation goes through moderate_review(), which only admins can run, so nobody can publish their own review.

-- ---- who counts as a verified parent ----
create or replace function public.is_verified_user()
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select coalesce(
    (select u.email_confirmed_at is not null or u.phone_confirmed_at is not null from auth.users u where u.id = auth.uid()),
    false);
$$;
revoke execute on function public.is_verified_user() from public;
grant execute on function public.is_verified_user() to authenticated;

-- ---- tables ----
create table public.school_reviews (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  title text check (title is null or char_length(title) <= 120),
  body text not null check (char_length(body) between 20 and 2000),
  relationship text not null default 'other' check (relationship in ('current_parent', 'former_parent', 'applicant', 'other')),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index school_reviews_school_status_idx on public.school_reviews (school_id, status);

-- Who wrote each review, and what the moderator said. Never readable by other parents.
create table public.school_review_private (
  review_id uuid primary key references public.school_reviews (id) on delete cascade deferrable initially deferred,
  school_id uuid not null references public.schools (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  moderation_note text,
  moderated_by uuid references public.profiles (id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (school_id, author_id)
);
create index school_review_private_author_idx on public.school_review_private (author_id, created_at);

create table public.review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.school_reviews (id) on delete cascade,
  reporter_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reason text not null check (reason in ('spam', 'abusive', 'fake', 'personal_info', 'other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  unique (review_id, reporter_id)
);
create index review_reports_review_idx on public.review_reports (review_id, status);

-- ---- helpers used by the policies ----
-- volatile on purpose: it must see the private row that the insert trigger creates in the same statement
create or replace function public.owns_review(p_review uuid)
 returns boolean
 language sql
 volatile
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.school_review_private p where p.review_id = p_review and p.author_id = auth.uid());
$$;

create or replace function public.can_report_review(p_review uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path = ''
as $$
  select exists (select 1 from public.school_reviews r where r.id = p_review and r.status = 'published')
     and not public.owns_review(p_review);
$$;
revoke execute on function public.owns_review(uuid), public.can_report_review(uuid) from public;
grant execute on function public.owns_review(uuid), public.can_report_review(uuid) to authenticated;

-- ---- triggers ----
create or replace function public.review_before_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to write a review' using errcode = '42501';
  end if;
  if (select count(*) from public.school_review_private p
      where p.author_id = auth.uid() and p.created_at > now() - interval '24 hours') >= 10 then
    raise exception 'daily review limit reached' using errcode = 'P0001';
  end if;
  new.status := 'pending';   -- whatever the client sent, a new review always waits for a moderator
  insert into public.school_review_private (review_id, school_id, author_id) values (new.id, new.school_id, auth.uid());
  return new;
end;
$$;
create trigger review_before_insert before insert on public.school_reviews
  for each row execute function public.review_before_insert();

create or replace function public.review_before_update()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if new.rating is distinct from old.rating or new.title is distinct from old.title
     or new.body is distinct from old.body or new.relationship is distinct from old.relationship then
    if old.status = 'removed' then
      raise exception 'this review was removed and cannot be edited' using errcode = '42501';
    end if;
    new.status := 'pending';    -- edited text is checked again before it shows
    new.updated_at := now();
    update public.school_review_private
       set moderation_note = null, moderated_by = null, moderated_at = null
     where review_id = new.id;
  end if;
  return new;
end;
$$;
create trigger review_before_update before update on public.school_reviews
  for each row execute function public.review_before_update();

create or replace function public.report_after_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if (select count(*) from public.review_reports r where r.review_id = new.review_id and r.status = 'open') >= 3 then
    update public.school_reviews set status = 'pending' where id = new.review_id and status = 'published';
  end if;
  return new;
end;
$$;
create trigger report_after_insert after insert on public.review_reports
  for each row execute function public.report_after_insert();

-- ---- moderation (admins only) ----
create or replace function public.moderate_review(p_review uuid, p_status text, p_note text default null)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'published', 'rejected', 'removed') then
    raise exception 'unknown status %', p_status;
  end if;
  update public.school_reviews set status = p_status where id = p_review;
  if not found then
    raise exception 'review not found';
  end if;
  update public.school_review_private
     set moderation_note = p_note, moderated_by = auth.uid(), moderated_at = now()
   where review_id = p_review;
  -- a final decision closes the open reports: keeping the review dismisses them, taking it down acts on them
  if p_status in ('published', 'rejected', 'removed') then
    update public.review_reports
       set status = case when p_status = 'published' then 'dismissed' else 'actioned' end
     where review_id = p_review and status = 'open';
  end if;
end;
$$;
revoke execute on function public.moderate_review(uuid, text, text) from public;
grant execute on function public.moderate_review(uuid, text, text) to authenticated;

-- ---- row level security ----
alter table public.school_reviews enable row level security;
alter table public.school_review_private enable row level security;
alter table public.review_reports enable row level security;

create policy "Published reviews are public" on public.school_reviews
  for select to anon, authenticated using (status = 'published');
create policy "Authors and admins see every review of their own scope" on public.school_reviews
  for select to authenticated using (public.owns_review(id) or public.is_admin());
create policy "Verified users can write reviews" on public.school_reviews
  for insert to authenticated with check (public.is_verified_user());
create policy "Authors can edit their own reviews" on public.school_reviews
  for update to authenticated using (public.owns_review(id)) with check (public.owns_review(id));
create policy "Authors and admins can delete reviews" on public.school_reviews
  for delete to authenticated using (public.owns_review(id) or public.is_admin());

create policy "Authors and admins can read review ownership" on public.school_review_private
  for select to authenticated using (author_id = auth.uid() or public.is_admin());

create policy "Reporters and admins can read reports" on public.review_reports
  for select to authenticated using (reporter_id = auth.uid() or public.is_admin());
create policy "Verified users can report published reviews that are not their own" on public.review_reports
  for insert to authenticated
  with check (reporter_id = auth.uid() and public.is_verified_user() and public.can_report_review(review_id));

-- ---- privileges: only what each role needs ----
revoke all on public.school_reviews, public.school_review_private, public.review_reports from anon, authenticated;
grant select on public.school_reviews to anon, authenticated;
grant insert (school_id, rating, title, body, relationship) on public.school_reviews to authenticated;
grant update (rating, title, body, relationship) on public.school_reviews to authenticated;
grant delete on public.school_reviews to authenticated;
grant select on public.school_review_private to authenticated;
grant select on public.review_reports to authenticated;
grant insert (review_id, reason, details) on public.review_reports to authenticated;

-- ---- what the app shows next to a school ----
create view public.school_review_stats with (security_invoker = true) as
  select school_id, count(*)::int as review_count, round(avg(rating)::numeric, 1) as avg_rating
  from public.school_reviews
  where status = 'published'
  group by school_id;
grant select on public.school_review_stats to anon, authenticated;
