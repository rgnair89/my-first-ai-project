-- 20260925000100_send_push_schedule.sql
--
-- Somebody has to ask send-push to go.
--
-- The triggers in 20260920000400_notifications.sql put a row in public.notifications the moment a school replies or an
-- application moves on, and the send-push edge function turns those rows into notifications on phones. But it only
-- does that when something calls it, and nothing was: the queue filled up and the phones stayed quiet. This asks
-- Postgres itself to call it once a minute. A parent hears within a minute of the school pressing send - soon enough,
-- and the unread marks inside the app were never waiting on this anyway.
--
-- Two things to do first, both in the Supabase dashboard:
--
--   1. Database -> Extensions: switch on "pg_cron" and "pg_net".
--
--   2. Project Settings -> Vault -> New secret:
--        Name    send_push_key
--        Secret  your sb_secret_... key, the same one send-push holds as SB_SECRET_KEY
--
--      The job reads the key from the vault each time it runs, so the key is never written into this file, into git,
--      or into the job's own definition. If you ever replace the key, change it in the vault and in the function's
--      secrets, and this carries on working.
--
-- Safe to run again: each job is replaced rather than doubled.

-- ---- what the job needs ----------------------------------------------------------------------------------------------
-- If either of these complains, switch it on from Database -> Extensions instead and run the rest.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---- once a minute: empty the queue ----------------------------------------------------------------------------------
select cron.unschedule('send-push') where exists (select 1 from cron.job where jobname = 'send-push');

select cron.schedule('send-push', '* * * * *', $job$
  select net.http_post(
    url     := 'https://twpcjrpknsqlycdvwtsj.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'send_push_key')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
$job$);

-- ---- once a night: throw away notifications nobody needs any more ----------------------------------------------------
-- Ninety days. Not on the hour, so it does not join everything else that runs at midnight.
select cron.unschedule('purge-notifications') where exists (select 1 from cron.job where jobname = 'purge-notifications');

select cron.schedule('purge-notifications', '17 2 * * *', $job$ select public.purge_old_notifications(90); $job$);

-- ---- how to see that it is working -----------------------------------------------------------------------------------
-- The two jobs, and whether they are on:
--   select jobid, jobname, schedule, active from cron.job order by jobname;
--
-- What happened the last few times they ran (a failed one says why):
--   select j.jobname, r.status, r.return_message, r.start_time
--     from cron.job_run_details r join cron.job j on j.jobid = r.jobid
--    order by r.start_time desc limit 20;
--
-- Anything still waiting to go out, and anything that gave up after three tries:
--   select count(*) filter (where push_sent_at is null and push_attempts < 3) as waiting,
--          count(*) filter (where push_sent_at is null and push_attempts >= 3) as gave_up,
--          count(*) filter (where push_sent_at is not null) as sent
--     from public.notifications;
--
-- To stop the sending for a while, without losing the queue:
--   update cron.job set active = false where jobname = 'send-push';
