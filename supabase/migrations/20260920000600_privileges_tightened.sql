-- supabase/migrations/20260920000600_privileges_tightened.sql
--
-- Take away everything nobody needs, and hand back only what each side actually uses.
--
-- Why: Supabase grants every new table in the public schema to the "anon" and "authenticated" roles in full - including
-- INSERT, UPDATE, DELETE and TRUNCATE - and relies on row level security to hold them back. Row level security does
-- hold for reading and writing rows, but TRUNCATE ignores it altogether, and a table added in a hurry without its own
-- rules would be wide open. The same goes for functions: every new function can be called by signed-out visitors
-- unless somebody remembers to revoke it.
--
-- So this file starts from nothing:
--   * signed-out visitors (anon): may read the public parts of a school, and call three functions the app needs before
--     anyone signs in. Nothing else. No writing anywhere.
--   * signed-in people (authenticated): may read what the rules already allow, and may write only their own profile
--     settings, their own reviews and reports, their own enquiries and messages, and forget their own phones.
--   * from now on, new tables and functions are not handed to signed-out visitors by default either.
-- Row level security still decides which rows; this decides which doors exist at all.
--
-- Needs 20260920000500 first. Safe to run more than once.

-- ---- start from nothing --------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon;
-- PUBLIC means "every role there is", so a function left with the default grant is callable by signed-out visitors
-- however often anon itself is revoked. Both have to go.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to service_role;

-- ---- what a signed-out visitor may read (a school and the public facts about it) --------------------------------------
grant select on public.schools, public.school_reviews, public.school_review_stats, public.school_facilities,
                public.school_achievements, public.school_fee_schedules to anon;

-- ...and the three functions the app uses before anyone signs in. is_admin has to stay callable because other tables'
-- rules call it; for a signed-out visitor it simply answers "no".
grant execute on function public.is_admin() to anon;
grant execute on function public.schools_nearby(double precision, double precision) to anon;
grant execute on function public.school_tiles(double precision, double precision, double precision) to anon;

-- ---- what a signed-in person may read --------------------------------------------------------------------------------
grant select on public.schools, public.school_reviews, public.school_review_stats, public.school_facilities,
                public.school_achievements, public.school_fee_schedules, public.school_review_private,
                public.review_reports, public.profiles, public.tickets, public.ticket_messages, public.enquiry_threads,
                public.school_staff, public.school_change_log, public.school_site_findings, public.applications,
                public.admission_applications, public.admission_application_events, public.school_crm_webhooks,
                public.crm_deliveries, public.outbound_clicks, public.push_devices, public.notifications,
                public.commute_settings, public.commute_usage, public.commute_usage_daily, public.security_settings
  to authenticated;

-- ---- and the few things they may write (the rules decide whose rows) ---------------------------------------------------
grant update (first_name, last_name, phone_number, language, notify_push) on public.profiles to authenticated;
grant insert (school_id, rating, title, body, relationship) on public.school_reviews to authenticated;
grant update (rating, title, body, relationship) on public.school_reviews to authenticated;
grant delete on public.school_reviews to authenticated;
grant insert (review_id, reason, details) on public.review_reports to authenticated;
grant insert (school_id, subject, grade_of_interest, start_year) on public.tickets to authenticated;
grant insert (ticket_id, message) on public.ticket_messages to authenticated;
grant delete on public.push_devices to authenticated;
-- the drive-time settings page in the Partner Portal (only an admin gets past the rules)
grant update (enabled, per_user_daily_lookups, global_daily_elements, max_schools_per_lookup) on public.commute_settings to authenticated;

-- ---- the everyday functions, back where they belong ---------------------------------------------------------------------
grant execute on function
  public.schools_nearby(double precision, double precision),
  public.school_tiles(double precision, double precision, double precision),
  public.is_admin(),
  public.is_verified_user(),
  public.owns_review(uuid),
  public.can_report_review(uuid),
  public.moderate_review(uuid, text, text),
  public.owns_ticket(uuid),
  public.can_answer_ticket(uuid),
  public.send_enquiry(uuid, text, text, text, integer),
  public.set_ticket_status(uuid, text),
  public.mark_ticket_read(uuid),
  public.take_commute_quota(integer),
  public.set_school_category(uuid, text),
  public.can_edit_school(uuid),
  public.is_school_staff(uuid),
  public.set_school_facility(uuid, text, boolean, text),
  public.save_school_achievement(uuid, uuid, text, text, int, text),
  public.delete_school_achievement(uuid),
  public.set_school_photo(uuid, text, text, text, text, text),
  public.add_school_staff(uuid, text),
  public.remove_school_staff(uuid, uuid),
  public.revert_school_change(bigint),
  public.can_edit_school_folder(text),
  public.set_school_levels(uuid, text[]),
  public.set_school_fees(uuid, text, jsonb),
  public.set_school_start_time(uuid, text),
  public.admission_classes(),
  public.can_see_application(uuid),
  public.submit_admission_application(uuid, jsonb),
  public.withdraw_admission_application(uuid),
  public.delete_admission_application(uuid),
  public.set_admission_status(uuid, text, text),
  public.valid_webhook_url(text),
  public.set_crm_webhook(uuid, text, boolean),
  public.rotate_crm_secret(uuid),
  public.remove_crm_webhook(uuid),
  public.queue_crm_test(uuid),
  public.retry_crm_delivery(bigint),
  public.log_outbound_click(uuid, text),
  public.outbound_click_stats(uuid, int),
  public.register_push_device(text, text),
  public.unregister_push_device(text),
  public.mark_notifications_read(bigint[]),
  public.recently_signed_in(int),
  public.delete_my_account_data(),
  public.mfa_ok(),
  public.set_require_mfa(boolean),
  public.app_languages(),
  public.review_site_finding(uuid, text[], boolean, text, text[], text[], integer[]),
  public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb, jsonb, jsonb)
  to authenticated;

-- the ones the edge functions use with the service key
grant execute on function
  public.claim_crm_deliveries(int),
  public.finish_crm_delivery(bigint, boolean, int, text),
  public.claim_push_batch(int),
  public.finish_push(bigint[]),
  public.forget_push_token(text),
  public.purge_old_notifications(int),
  public.record_site_finding(uuid, text, jsonb, jsonb, jsonb, text, jsonb, jsonb, jsonb),
  public.schools_nearby(double precision, double precision),
  public.storage_public_prefix()
  to service_role;

-- ---- and for whatever gets added next ------------------------------------------------------------------------------------
-- New tables and functions are no longer handed to signed-out visitors on their own; each migration says what they may
-- have, as the ones above do.
--
-- This is set for every role we are allowed to set it for. On a hosted Supabase project that is the role running this
-- file (postgres), which is also the role that creates everything in these migrations - so anything added by a later
-- migration is covered. supabase_admin belongs to Supabase and cannot be changed from here; the notice below says so
-- rather than the whole migration failing over something no project owner can do.
do $$
declare
  r text;
begin
  for r in select rolname from pg_roles where rolname in ('postgres', 'supabase_admin') loop
    begin
      execute format('alter default privileges for role %I in schema public revoke insert, update, delete, truncate on tables from anon', r);
      execute format('alter default privileges for role %I in schema public revoke execute on functions from anon', r);
    exception when insufficient_privilege then
      raise notice 'default privileges left alone for %: this project may not change that role. Anything that role creates by itself is not covered; everything these migrations create is.', r;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
