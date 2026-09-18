-- schools.name_sort: the name as a person would alphabetise it, for the app's A to Z list. Safe to run more than once.
--
--   "(S.E.S) SITALDAS KHEMANI HIGH SCHOOL"              -> "ses sitaldas khemani high school"
--   "<emoji>Smiling Kids Pre-school <emoji> and ..."    -> "smiling kids preschool and ..."
--   "270 Degree Kids Preschool, Thane | Best Preschool" -> "270 degree kids preschool thane"
--
-- The part after " | " is dropped (it is usually search-engine text). Punctuation, brackets, dashes, arrows and other
-- symbols, and emoji are removed; letters, digits and the vowel marks of Indian scripts are kept. The ranges below are
-- written as \U0000XXXX escapes (plain ASCII), so this file survives copy and paste. The column uses collation "C"
-- (plain character order: digits, then a-z, then other scripts), so the order is the same on any database setup.
-- The app adds the school id as a final tie-break, so equal names keep a fixed order.
--
-- To change the recipe later: replace the column expression, or run   update public.schools set name = name;

alter table public.schools
  add column if not exists name_sort text collate "C"
    generated always as (
      btrim(
        regexp_replace(
          regexp_replace(
            lower(split_part(name, ' | ', 1)),
            '[\U00000021-\U0000002F\U0000003A-\U00000040\U0000005B-\U00000060\U0000007B-\U0000007E\U000000A1-\U000000A9\U000000AB-\U000000B4\U000000B6-\U000000B9\U000000BB-\U000000BF\U00002010-\U00002027\U00002030-\U0000205E\U00002190-\U000023FF\U00002600-\U000027BF\U00002B00-\U00002BFF\U0000200B-\U0000200F\U00003000-\U0000303F\U0000FE00-\U0000FE0F\U0001F000-\U0001FAFF]',
            '', 'g'),
          '\s+', ' ', 'g')
      )
    ) stored;

create index if not exists schools_name_sort_idx on public.schools (name_sort, id);
