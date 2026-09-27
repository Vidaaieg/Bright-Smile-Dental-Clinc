# The four layers of security

The clinic stores health data: who is coming in, when, for what treatment, and
what they paid. That is the kind of data that has to be protected in depth — so
that no single mistake is enough to expose it.

Four independent layers do that. Each one assumes the layer above it has already
failed.

| # | Layer | Question it answers | Where it lives |
|---|---|---|---|
| 1 | Authentication | *Who are you?* | Supabase Auth, [js/auth.js](js/auth.js) |
| 2 | Row Level Security | *Which rows may you touch?* | [supabase/schema.sql](supabase/schema.sql) |
| 3 | Database hardening | *Is the data itself valid, and who did what?* | [supabase/security.sql](supabase/security.sql) |
| 4 | The API edge | *Is this caller allowed to reach this function at all?* | [supabase/functions/](supabase/functions/) |

---

## Layer 1 — Authentication

**Identity, proven by the server, not claimed by the browser.**

- Passwords never reach this codebase. Supabase hashes and verifies them; there
  is no password field in any table.
- Sign-up metadata is copied into `profiles` by the `handle_new_user()` trigger,
  so a profile row always belongs to a real `auth.users` row.
- A failed login returns one deliberately vague message
  ([js/auth.js:130](js/auth.js#L130)). Saying "no such email" would let anyone
  test whether a given person is a patient here — itself a health disclosure.
- Minimum 8-character passwords, checked in the browser and again by Supabase.
- Every request to the database carries a JWT. Layer 2 reads the user id out of
  it as `auth.uid()`; the browser cannot forge that value.

**To verify:** log in, then in the console run
`await DentalDB.client.auth.getSession()` — you should see a session with a
`user.id`, and that id is what every policy below filters on.

---

## Layer 2 — Row Level Security

**Even with a valid login, you only ever see your own rows.**

RLS is ON for every table in `public`. With RLS on, *nothing* is readable until a
policy explicitly allows it — the default is denial, not access.

| Table | Patient may | Patient may **not** |
|---|---|---|
| `profiles` | read / update / insert their own | read anyone else's |
| `services` | read the active price list | write anything |
| `appointments` | read own, book own (future only), cancel own | mark anything `paid` |
| `payments` | read own | insert or update — **no policy exists** |
| `audit_log` | — | anything: RLS on, zero policies |

Two of these are worth spelling out:

- **Patients cannot mark themselves paid.** The `appointments` update policy
  ([schema.sql:154](supabase/schema.sql#L154)) allows the status to land only on
  `pending_payment` or `cancelled`. `paid` is reachable only by the webhook,
  which runs as `service_role` and bypasses RLS.
- **A table with RLS on and no policy is fully sealed.** That is how `payments`
  stays write-only-by-server and how `audit_log` stays unreadable, without
  needing a rule for every case.

**To verify:**

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';
select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public';
```

Every row of the first query must show `rowsecurity = true`. If a new table ever
appears with `false`, it is readable by the whole internet.

---

## Layer 3 — Database hardening

**Assume a policy is wrong. The data still cannot be corrupted.**

Run [supabase/security.sql](supabase/security.sql) after `schema.sql`. It adds
four things RLS does not cover:

1. **Least privilege on the API roles.** Grants are *revoked* from `anon` and
   `authenticated` for everything they should never need — creating tables,
   writing prices, writing payments, deleting appointments. A missing or
   mistaken policy is then not enough on its own to leak or destroy data.

2. **Constraints that make bad data impossible.** Email shape, phone shape, name
   length, and no booking more than a year out. The browser checks these too,
   but browser validation is a convenience for honest users — anyone can bypass
   it with `curl`. The constraint is the actual control.

3. **Anti-abuse triggers.** A unique index stops two patients holding the same
   slot; `check_booking_limits()` caps 5 bookings per hour and 3 unpaid
   appointments at once, so nobody can block out the calendar for free.

4. **An append-only audit log.** Every insert, update and delete on
   `appointments` and `payments` is recorded with the actor's `auth.uid()`, the
   old row and the new row. Nothing reachable over HTTP can read or edit it.

**To verify** — this should return only `audit_log` (tables sealed with no
policy):

```sql
select t.tablename from pg_tables t
left join pg_policies p on p.tablename = t.tablename
where t.schemaname = 'public' and t.rowsecurity and p.policyname is null;
```

---

## Layer 4 — The API edge

**This is the layer that is easy to forget.** Layers 1–3 all live inside the
database. Layer 4 is about the Edge Functions in front of it — the only code
that holds secrets and the only code that can bypass RLS.

Every function enforces its own answer to *"should this caller be here at all?"*,
because each has a different kind of caller:

| Function | Caller | Control | Deployed with |
|---|---|---|---|
| `create-payment` | our own site, logged-in patient | JWT **+ origin allow-list** | *(JWT verified)* |
| `paymob-webhook` | Paymob's servers | HMAC-SHA512 signature | `--no-verify-jwt` |
| `clinic-api` | n8n (a machine, no login) | API key, constant-time compared | `--no-verify-jwt` |
| `notify-n8n` | Supabase Database Webhook | JWT *(and it signs what it sends)* | *(JWT verified)* |

The rules that make this layer hold:

- **No secret is ever in the browser.** The Paymob API key, the `service_role`
  key, the clinic API key and the n8n shared secret exist only as Edge Function
  secrets. The only key in `js/supabase-client.js` is the `anon` key, which is
  *designed* to be public — it grants nothing beyond what Layer 2 allows.

- **The origin allow-list.** `create-payment` echoes `Access-Control-Allow-Origin`
  only for origins on the list, never `*`, and rejects other origins outright
  ([create-payment/index.ts:28](supabase/functions/create-payment/index.ts#L28)).
  Set it, or it defaults to localhost only:

  ```bash
  supabase secrets set ALLOWED_ORIGINS="https://yourdomain.com"
  ```

- **The amount is never taken from the request.** `create-payment` reads the
  price from the `services` table server-side, so editing the page cannot make
  an implant cost 1 EGP. The webhook then *re-checks* the charged amount before
  writing `paid`.

- **Signatures on everything crossing a trust boundary.** Inbound from Paymob:
  HMAC-SHA512, verified before the payload is trusted at all. Outbound to n8n:
  HMAC-SHA256 in `X-DentalClinic-Signature`, so n8n can tell a real event from
  someone who merely learned the URL.

- **Both key comparisons are constant-time**, so a key cannot be recovered
  character by character from response timing.

- **`clinic-api` is an allow-list of four actions**, not a generic query
  endpoint. It runs as `service_role` and therefore bypasses every layer above —
  which is exactly why the key check happens before anything else, and why that
  key must be treated as a password to the entire database.

**To verify** — a request with no key must be refused:

```bash
curl -i -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/clinic-api \
  -H 'Content-Type: application/json' -d '{"action":"list_appointments"}'
# expect: HTTP/2 401  {"error":"Unauthorised."}
```

---

## What is deliberately not stored

- **No card numbers, ever.** The site has no card fields. Paymob's iframe
  collects them on Paymob's domain; the clinic's database only ever sees an
  amount and a transaction id.
- **No treatment notes or medical records.** Only which service was booked.
- **Nothing about health goes to Meta.** See the two rules at the top of
  [js/analytics.js](js/analytics.js): the pixel never loads without consent and
  never loads on booking, payment, login or signup pages.

## Still to do before real patients

- Connect a real SMTP provider (Authentication → Emails). Supabase's built-in
  sender is rate-limited and meant for testing only.
- Set `ALLOWED_ORIGINS` to the real domain.
- Run the payment path end to end in Paymob test mode — it has never been run
  against a live account.
- Turn on Point-in-Time Recovery (Database → Backups) once on a paid plan. None
  of the above helps against accidental deletion.
