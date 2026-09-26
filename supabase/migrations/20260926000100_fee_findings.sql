-- 20260926000100_fee_findings.sql
--
-- Fees that nobody has typed in.
--
-- 4,975 schools, 2,277 of them with a website, and not one fee in the database. "First year cost" is a column in the
-- app's comparison and it says "Not known" for every school in it. The only way to fill it today is for a person to
-- open one school at a time and type nine numbers.
--
-- The crawler has been report-only since it was written, and rightly so: the version before it guessed. It took the
-- median of every rupee figure on a page and called it a fee, which is how a school with a 25,000 uniform bill ends
-- up advertised at 25,000 a year. A wrong fee is worse than no fee - a family choosing a school on a wrong number is
-- a real harm, and they have no way of knowing.
--
-- So this does not let the crawler write fees. It gives it somewhere to put what it *saw*, with the page it saw it on
-- and the row it read, and a person turns that into a fee in one press instead of nine. The crawler proposes; a human
-- decides; the fee that reaches a parent is still one a person agreed to, and carries a link to where it came from.

-- ---- what the crawler saw --------------------------------------------------------------------------------------------
create table if not exists public.school_fee_findings (
  id bigserial primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  source_url text not null check (source_url ~* '^https?://' and char_length(source_url) <= 500),

  -- what the page actually said, kept word for word so a person can judge it without leaving the portal
  grade_text text check (grade_text is null or char_length(grade_text) <= 120),
  component_text text check (component_text is null or char_length(component_text) <= 120),
  evidence text not null check (char_length(evidence) between 1 and 400),

  -- what Kidscover made of it, which is a reading and may be wrong
  level text check (level is null or level in ('daycare', 'preschool', 'primary', 'secondary')),
  academic_year text check (academic_year is null or academic_year ~ '^20[0-9]{2}-[0-9]{2}$'),
  component text not null check (component in ('tuition', 'transport', 'meals', 'uniform_books', 'activities',
                                               'other_annual', 'admission_fee', 'registration_fee', 'deposit', 'unknown')),
  amount integer not null check (amount between 1 and 5000000),
  -- "high" means the row named a class and named what the money was for. "low" means one of those was a guess.
  confidence text not null check (confidence in ('high', 'low')),

  status text not null default 'new' check (status in ('new', 'accepted', 'rejected')),
  found_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,

  -- crawling the same page again should not pile up the same line a second time
  unique (school_id, source_url, grade_text, component_text, amount)
);

create index if not exists school_fee_findings_waiting
  on public.school_fee_findings (school_id, level, id) where status = 'new';

comment on table public.school_fee_findings is
  'What the fee crawler read on a school website. Proposals, not fees: nothing here is shown to a parent until an admin accepts it.';

-- ---- who may see it --------------------------------------------------------------------------------------------------
-- Nobody but a Kidscover admin. A half-read number with no one behind it is not something to put in front of a family,
-- and not something a school should be judged on either.
alter table public.school_fee_findings enable row level security;

drop policy if exists "Only admins see fee findings" on public.school_fee_findings;
create policy "Only admins see fee findings" on public.school_fee_findings
  for select using (public.is_admin());

revoke all on public.school_fee_findings from anon, authenticated;
grant select on public.school_fee_findings to authenticated;

-- ---- the schools still waiting to be looked at -------------------------------------------------------------------------
create or replace view public.fee_findings_waiting
with (security_invoker = true) as
  select f.school_id,
         s.name as school_name,
         s.address,
         count(*) as findings,
         count(*) filter (where f.confidence = 'high') as confident,
         min(f.source_url) as source_url,
         max(f.academic_year) as academic_year,
         array_agg(distinct f.level) filter (where f.level is not null) as levels,
         max(f.found_at) as last_found_at
    from public.school_fee_findings f
    join public.schools s on s.id = f.school_id
   where f.status = 'new'
   group by f.school_id, s.name, s.address;

comment on view public.fee_findings_waiting is
  'One row per school with fee lines waiting to be judged, most useful first.';

-- ---- a person turns findings into a fee --------------------------------------------------------------------------------
-- p_fees is the same shape set_school_fees already takes, so there is one place where a fee is checked, not two.
-- The findings named in p_ids are what the person was looking at when they decided, and are marked as dealt with.
create or replace function public.accept_fee_findings(p_ids bigint[], p_level text, p_fees jsonb)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_schools uuid[];
  v_school uuid;
  v_url text;
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can turn a finding into a fee' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'Say which lines this fee came from' using errcode = '22023';
  end if;

  select array_agg(distinct school_id) into v_schools
    from public.school_fee_findings where id = any(p_ids) and status = 'new';

  if v_schools is null then
    raise exception 'Those lines have already been dealt with' using errcode = 'P0002';
  end if;
  if array_length(v_schools, 1) <> 1 then
    raise exception 'All the lines must be from the same school' using errcode = '22023';
  end if;
  v_school := v_schools[1];

  -- the page it was read from goes with the fee, so a parent can see where the number came from
  select min(source_url) into v_url from public.school_fee_findings where id = any(p_ids);

  perform public.set_school_fees(v_school, p_level,
    p_fees - 'source_url' || jsonb_build_object('source_url', coalesce(p_fees->>'source_url', v_url)));

  -- set_school_fees records who was typing. This fee was read off the school's own website, and that is what a
  -- parent is told - "Found on the school's website" - with the page itself one tap away.
  update public.school_fee_schedules
     set source = 'school website'
   where school_id = v_school and level = p_level;

  update public.school_fee_findings
     set status = 'accepted', decided_by = auth.uid(), decided_at = now()
   where id = any(p_ids) and status = 'new';
end;
$$;

create or replace function public.reject_fee_findings(p_ids bigint[])
 returns integer
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Only a Kidscover admin can set a finding aside' using errcode = '42501';
  end if;
  update public.school_fee_findings
     set status = 'rejected', decided_by = auth.uid(), decided_at = now()
   where id = any(coalesce(p_ids, '{}')) and status = 'new';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.accept_fee_findings(bigint[], text, jsonb) from public, anon;
revoke execute on function public.reject_fee_findings(bigint[]) from public, anon;
grant execute on function public.accept_fee_findings(bigint[], text, jsonb) to authenticated;
grant execute on function public.reject_fee_findings(bigint[]) to authenticated;

-- ---- and a way to let go of the ones nobody will ever act on -------------------------------------------------------
-- Findings are cheap to make and go stale: a school changes its fee page and last year's reading is no longer true.
create or replace function public.purge_old_fee_findings(p_days int default 120)
 returns integer
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.school_fee_findings
   where status <> 'accepted'
     and found_at < now() - make_interval(days => greatest(30, least(coalesce(p_days, 120), 730)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.purge_old_fee_findings(int) from public, anon, authenticated;
