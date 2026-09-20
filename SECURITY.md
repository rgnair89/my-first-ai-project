# Kidscover — security and privacy

Last reviewed: 20 September 2026, against everything in this repository and in `kidscover-app` at that date.

This is written for the person running Kidscover, not for a security team. It says what protects a family's details,
what was found and fixed in the review, what only you can do, and — plainly — what nobody can promise.

---

## 1. What the review covered

- **Every database rule**, by building the whole database from the migrations in an in-memory Postgres and then
  *acting* as a signed-out visitor, a signed-in stranger, a parent, a school's staff member, a Kidscover admin and the
  background service, and checking what each one could actually read, write, empty or call. (`audit`, `audit-everyday`)
- **Every server function** (drive times, the website reader, the CRM sender, push, account deletion), against
  stand-in databases and stand-in websites, including the ways they can be abused.
- **The Partner Portal and the parent app**, screen by screen, in a simulated browser.
- **The dependencies** of both projects (`npm audit`).
- The usual foot-guns: row level security left off, a function with a loose search path, a view that ignores the
  rules, rights handed out by default, secrets in code or in git.

Roughly 1,300 automated checks run over this; about 200 of them exist only to prove that someone who should not see
something cannot see it. The checks run again on every change.

## 2. What was found, and fixed

| What | Why it mattered | Fixed by |
|---|---|---|
| Supabase grants every new table in full to the "anon" (signed-out) and "authenticated" roles by default, including TRUNCATE. Row level security does not apply to TRUNCATE. | A table added without its own rules would have been wide open, and a bug could have emptied one. | `20260920000600`: everything is taken away, then only what each side uses is handed back. A table created by these migrations, or by the role that runs them, is not handed to signed-out visitors any more. Supabase's own `supabase_admin` role cannot be changed from a hosted project, so anything **it** creates by itself is outside this; the migration says so when it runs, rather than failing. |
| Every function was callable by signed-out visitors, because the default EXECUTE goes to PUBLIC. | Internal functions (moderation, triggers, helpers) could be called by anyone with the public key. | Same migration: EXECUTE revoked from PUBLIC and anon; three functions granted back (the school list, near-me and the dashboard counts). |
| A school's photo address only had to *look* like a storage address. | A school's staff could have pointed their photo at an image on another website, which then sees every parent who opens that page. | `20260920000500`: a school photo must be a file in Kidscover's own storage, in that school's own folder, with nothing tacked on. |
| The old `applications` table let a parent write any status. | A family could mark their own application "accepted". | `20260920000300`: no writing rights for anyone; the new admission form goes through a checked function. |
| A "keep who set this" rule could be skipped. | The database would have accepted hand-set levels with nobody recorded against them (a NULL made the check pass). | Fixed while it was being written; a test now proves it. |
| The website reader refused addresses that *said* 10.0.0.1, but not a public name that quietly points there. | A hostile school website could have made Kidscover fetch something inside Supabase's own network. | The reader now looks the name up and refuses private addresses; the CRM sender does the same, and follows no redirects. |
| The portal had no security headers. | Another site could have framed the portal and stolen clicks from an admin. | `next.config.mjs`: framing refused, a content policy, a referrer policy, a permissions policy, nosniff, HSTS. |
| A signed-in stranger could see a fee table with invented numbers from an old crawler. | Wrong money on a school's page. | The old table is no longer readable by either app; the new fee model replaces it. |

Nothing found was being exploited, and no family's data was exposed: the portal and the app have only ever been used
by you.

## 3. How each kind of data is protected

**Children's details** (the admission form: name, date of birth, class, address, the parent's phone and email) are the
most sensitive thing here.

- A parent types them and ticks a box naming the school before anything is sent.
- They can be read by exactly three parties: that parent, the staff of that one school, and a Kidscover admin. A
  second school, another parent and a signed-out visitor get nothing — tested from each of those seats.
- The family can withdraw the application, or delete it outright, at any time.
- They reach the school's own system only over https, signed with that school's secret, never following a redirect,
  and never to an address that resolves inside a private network.
- Nothing about a child appears in a notification, in a log, or on a locked screen.

**Conversations with a school** are visible to the parent, that school and Kidscover. A school never sees the
parent's email address; Kidscover passes the words on. Every message records which side wrote it.

**Parent reviews** are anonymous by construction: the public table has no author column at all. Who wrote what lives
in a separate table only the author and Kidscover can read.

**Where a parent is** is never stored. It goes to Google for one drive-time calculation and is thrown away.

**The sign-in on the phone** is encrypted with a key held in the phone's own keystore. With "unlock with a
fingerprint" on, the app locks itself two minutes after it is put away.

**Secrets** (the Supabase secret key, Google's key, each school's signing secret) are only ever in Supabase's own
secret store or in a database schema the apps cannot reach. None are in this repository, in the app, or in git.
The signing secret is shown once, when it is made.

**Deleting an account** removes the person's reviews, applications, notifications, phones and staff access, then the
sign-in itself, which takes their profile, enquiries and messages with it. It asks for the password again first.

## 4. What only you can do

These are settings in the Supabase dashboard, or actions on your accounts. I cannot make them for you.

1. **Turn on two-step sign-in for the portal.** Partner Portal → Security → set up an authenticator app, then switch
   on "Require two-step sign-in". After that a stolen password alone reaches nothing. This is the single biggest
   thing on this list.
2. **Rotate any key that has ever been pasted anywhere it should not have been** (Supabase → Settings → API keys, and
   the Google Cloud key). If in doubt, rotate.
3. **Supabase → Authentication → Providers → Email**: keep "Confirm email" on, and set a minimum password length of
   at least 10. On a paid plan, switch on leaked-password protection.
4. **Supabase → Authentication → URL configuration**: keep the redirect allow-list to your own portal address, so a
   confirmation link cannot be pointed at someone else's site.
5. **Supabase → Authentication → Rate limits**: keep the defaults or lower them; they are what stops password
   guessing and sign-up floods.
6. **Supabase → Settings → Database**: turn on daily backups (and point-in-time recovery when there is real data).
   The best answer to "someone deleted everything" is a restore.
7. **Keep the service-role / secret key out of the browser.** It belongs only in Edge Function secrets.
8. **Before the app goes to real families**: write a privacy policy saying what is kept and for how long, and have an
   independent penetration test. Under India's DPDP Act, children's data needs verifiable parental consent and cannot
   be used for advertising or tracking — Kidscover is built that way, but the paperwork is yours.

## 5. What cannot be promised

I have fixed everything the review found, and the checks above run on every change. I still cannot tell you there are
no vulnerabilities, and neither can anyone else. What is honestly true is narrower:

- The rules were tested from the seat of every kind of user, and they hold for the cases tested.
- Things outside this code — Supabase itself, Google, Expo, the phone, a stolen laptop, a staff member who is careless
  with their password — are not covered by any of it.
- A person with a valid school-staff account can see the applications sent to their own school. That is the point of
  the feature; the protection is that you choose who gets an account, two-step sign-in, and the change log.
- Ten "moderate" advisories are reported by `npm audit` in the app. All ten are the same `uuid` issue inside Expo's
  **command-line tooling**, which never ships to a phone: the app bundle contains only the app and its runtime
  libraries. Nothing in the portal has an open advisory.

If you want a single sentence: **a family's details are locked to that family, their school and you, and the review
found and fixed seven real weaknesses — but treat any claim of "no vulnerabilities at all" with suspicion, including
from me.**
