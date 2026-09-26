-- 20260926000200_fee_crawl_log.sql
--
-- What happened when we read a school's website for fees, kept so it can be counted.
--
-- Reading eight websites taught us more than the one fee line it produced. Podar's "Fee Structure" page is empty and
-- the fee sits behind an enquiry form; Bombay International School's says "please email us"; Rose English High School
-- does not use the word "fee" anywhere. The crawler read all three correctly. There was nothing on them.
--
-- So the question that decides the next piece of work is not "can we parse better" but "where are the fees actually
-- kept". Every CBSE school is required by law to publish a Mandatory Public Disclosure, and the fee structure is on
-- it - as a PDF. If most schools have one, a PDF reader is worth building. If few do, it is not, and the answer is to
-- ask schools directly through the portal instead.
--
-- One row per school, replaced each time it is read. Counting these answers the question without a single call to
-- any paid API.

create table if not exists public.school_fee_crawls (
  school_id uuid primary key references public.schools (id) on delete cascade,
  read_at timestamptz not null default now(),
  -- what we ended up with:
  --   table            - numbers were readable on a page, whatever we made of them
  --   pdf_only         - a fee page linked a PDF and had nothing readable itself
  --   page_no_numbers  - we found a fee page and it carried no amounts at all (a form, or "email us")
  --   no_fee_page      - nothing on the site looked like a way to the fees
  --   failed           - the site could not be read
  outcome text not null check (outcome in ('table', 'pdf_only', 'page_no_numbers', 'no_fee_page', 'failed')),
  fee_page text check (fee_page is null or char_length(fee_page) <= 500),
  pdf_url text check (pdf_url is null or char_length(pdf_url) <= 500),
  lines_found integer not null default 0 check (lines_found between 0 and 10000),
  lines_confident integer not null default 0 check (lines_confident between 0 and 10000),
  note text check (note is null or char_length(note) <= 300)
);

create index if not exists school_fee_crawls_by_outcome on public.school_fee_crawls (outcome, read_at desc);

comment on table public.school_fee_crawls is
  'One row per school: what reading its website for fees actually turned up. Kept so the outcomes can be counted.';

alter table public.school_fee_crawls enable row level security;
drop policy if exists "Only admins see fee crawls" on public.school_fee_crawls;
create policy "Only admins see fee crawls" on public.school_fee_crawls
  for select using (public.is_admin());

revoke all on public.school_fee_crawls from anon, authenticated;
grant select on public.school_fee_crawls to authenticated;

-- ---- the count that decides what to build next -------------------------------------------------------------------
create or replace view public.fee_crawl_outcomes
with (security_invoker = true) as
  select outcome,
         count(*) as schools,
         sum(lines_found) as lines_found,
         sum(lines_confident) as lines_confident,
         count(*) filter (where pdf_url is not null) as with_a_pdf,
         max(read_at) as last_read_at
    from public.school_fee_crawls
   group by outcome;

comment on view public.fee_crawl_outcomes is
  'How the schools read so far divide up. "pdf_only" is the number that decides whether a PDF reader is worth writing.';
