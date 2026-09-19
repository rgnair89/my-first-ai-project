-- supabase/migrations/20260919000900_enquiry_read_marks_for_old_threads.sql
--
-- Fix for 20260919000600_admissions_enquiries.sql. The enquiries made before it were moved into the new conversations
-- without read marks, so a parent's own old message counted as unread for them: the app showed "Enquiries (1)" when
-- nobody had replied.
--
-- A parent has read what they wrote themselves. So every thread with no message from the school since the parent
-- last read it is marked read up to its latest message. A school reply the parent has not opened stays unread.
-- The staff side is left alone: an old enquiry nobody has answered still needs a reply.
-- Changes read marks only (no messages, statuses or rules). Safe to run more than once.

update public.tickets t
   set parent_read_at = t.last_message_at
 where t.last_message_at is not null
   and t.last_message_at > coalesce(t.parent_read_at, '-infinity'::timestamptz)
   and not exists (
         select 1
           from public.ticket_messages m
          where m.ticket_id = t.id
            and m.sender_id is distinct from t.parent_id
            and m.created_at > coalesce(t.parent_read_at, '-infinity'::timestamptz));
