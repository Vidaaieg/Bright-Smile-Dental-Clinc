# Connecting Bright Smile Clinic to Supabase, Paymob, n8n and Meta

Follow part 1 first. The site works with real accounts and real bookings after
part 1 alone — everything after it can wait.

| Part | What it adds | Needed for the site to work? |
|---|---|---|
| 1 | Supabase — accounts, appointments, security | **Yes** |
| 2 | Paymob — card payments | No |
| 3 | n8n — automation (API key + webhook) | No |
| 4 | Meta Pixel — ads and analytics | No |

Security is documented separately in [SECURITY.md](SECURITY.md).

---

## Part 1 — Supabase (accounts + appointments)

### 1. Create the project

1. Go to <https://supabase.com> and sign up.
2. **New project** → name it `dental-clinic`.
3. Pick a strong database password and **save it somewhere safe** — it is shown once.
4. For region choose **Frankfurt (eu-central-1)**; it is the closest to Egypt of
   the European regions and keeps the site fast for local patients.
5. Wait ~2 minutes while the project is provisioned.

### 2. Create the tables

1. In the left sidebar: **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this project, copy the whole file, paste it in.
3. Press **Run**.
4. You should see `Success. No rows returned`.
5. Check it worked: **Table Editor** should now list `profiles`, `services`,
   `appointments` and `payments`, and `services` should have 9 rows.
6. **New query** again, and repeat with `supabase/security.sql`. Do not skip
   this — it is the layer that revokes unnecessary permissions, blocks double
   bookings and turns on the audit log. Both files are safe to re-run.
7. Confirm every table is protected:

   ```sql
   select tablename, rowsecurity from pg_tables where schemaname = 'public';
   ```

   Every row must say `true`. See [SECURITY.md](SECURITY.md) for what each layer
   does and how to check it.

### 3. Set your real prices

The schema seeds **placeholder prices** — they are guesses, not the clinic's prices.

1. **Table Editor** → `services`.
2. Edit `price_piastres` for each row. The unit is **piastres**, so
   multiply EGP by 100: a 500 EGP consultation is `50000`.

Prices deliberately live here and not in the website code, so a patient cannot
change what they are charged by editing the page in their browser.

### 4. Connect the website

1. **Project Settings** (gear icon) → **API**.
2. Copy **Project URL** and the **anon public** key.
3. Open `js/supabase-client.js` and replace the two placeholders:

```js
window.DENTAL_CONFIG = {
   SUPABASE_URL: 'https://xxxxxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

> **The anon key is safe to publish.** It only ever grants what the Row Level
> Security policies allow. The **`service_role`** key on that same page is the
> opposite — it bypasses every security rule. Never put it in any file the
> browser downloads, never paste it into a chat, never commit it.

### 5. Set the site URL

**Authentication** → **URL Configuration** → set **Site URL** to where the site is
hosted (`http://localhost:5500` while developing). Confirmation emails link back
to this address, so if it is wrong the links break.

### 6. Test it

Serve the folder over HTTP — opening `index.html` by double-clicking gives a
`file://` page, and browsers block the Supabase calls there.

```bash
npx serve .
```

Then: **Sign Up** → check your inbox → confirm → **Login** → book an appointment.
The row should appear in **Table Editor → appointments** with status
`pending_payment`.

> Supabase's built-in email sender is rate-limited to a few messages per hour and
> is only meant for testing. Before real patients use this, connect a proper SMTP
> provider under **Authentication → Emails**.

---

## Part 2 — Paymob (card payments)

Stripe does not support businesses in Egypt, so this uses **Paymob**.

### 1. Get a merchant account

1. Sign up at <https://paymob.com> and complete the merchant onboarding.
   This needs a **registered business**: commercial register, tax card and a
   bank account in the clinic's name. Expect a few days for approval.
2. Once approved: **Developers → Payment Integrations** → create a **card**
   integration.
3. Collect four values:

| Value | Where |
|---|---|
| API key | Settings → Account Info |
| Card integration ID | Developers → Payment Integrations |
| iFrame ID | Developers → iFrames (create one) |
| HMAC secret | Settings → Account Info |

### 2. Deploy the Edge Functions

Install the CLI, then from the project folder:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF

supabase secrets set PAYMOB_API_KEY="..."
supabase secrets set PAYMOB_CARD_INTEGRATION_ID="..."
supabase secrets set PAYMOB_IFRAME_ID="..."
supabase secrets set PAYMOB_HMAC_SECRET="..."

supabase functions deploy create-payment
supabase functions deploy paymob-webhook --no-verify-jwt
```

`--no-verify-jwt` on the webhook is required: Paymob's servers have no Supabase
login. The function protects itself with the HMAC signature check instead.

### 3. Point Paymob at the webhook

In Paymob → **Developers → Payment Integrations** → your card integration, set
the **Transaction processed callback** to:

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/paymob-webhook
```

### 4. Test with Paymob's test cards

Use the test card numbers from the Paymob dashboard while your integration is in
test mode. A successful payment should flip the `payments` row to `paid` and the
`appointments` row to `paid`.

---

## Part 3 — n8n (automation)

Two Edge Functions connect the clinic to n8n. They are independent — set up
either, both, or neither. **You wire the n8n side manually; this part only
prepares the endpoints and the credentials they expect.**

### A. Outbound: the site tells n8n something happened

`notify-n8n` fires when an appointment or payment is created or changed — use it
for WhatsApp confirmations, reminders, calendar entries, alerting reception.

```bash
supabase secrets set N8N_WEBHOOK_URL="https://your-n8n/webhook/dental"
supabase secrets set N8N_SHARED_SECRET="$(openssl rand -hex 32)"
supabase functions deploy notify-n8n
```

Then make it fire automatically: **Dashboard → Database → Webhooks → Create**

| Field | Value |
|---|---|
| Table | `appointments` (repeat for `payments`) |
| Events | Insert, Update |
| Type | Supabase Edge Function → `notify-n8n` |

**In n8n:** add a Webhook node, then verify the `X-DentalClinic-Signature`
header — it is an HMAC-SHA256 of the raw body, hex-encoded, using
`N8N_SHARED_SECRET`. Without that check, anyone who learns your n8n URL can post
fake appointments into your workflow.

The payload:

```json
{
  "event": "appointments.insert",
  "sent_at": "2026-03-01T09:00:00.000Z",
  "data": {
    "id": "…", "table": "appointments", "status": "pending_payment",
    "service_slug": "root-canal", "service_name": "Root canal specialist",
    "scheduled_at": "…", "patient_name": "…",
    "patient_email": "…", "patient_phone": "…",
    "amount_piastres": null, "currency": null
  }
}
```

### B. Inbound: n8n asks the site for data

`clinic-api` lets a workflow read and update appointments — for a "remind
everyone booked tomorrow" schedule, or a reception dashboard.

```bash
supabase secrets set CLINIC_API_KEY="$(openssl rand -hex 32)"
supabase functions deploy clinic-api --no-verify-jwt
```

`--no-verify-jwt` is required because n8n is a machine with no Supabase login.
The API key is what protects it instead.

**In n8n:** an HTTP Request node, POST, with a header credential:

```
X-API-Key: <the value you generated>
```

to `https://YOUR_PROJECT_REF.supabase.co/functions/v1/clinic-api`, body:

| Body | Returns |
|---|---|
| `{"action":"tomorrow_reminders"}` | everything paid and booked for tomorrow |
| `{"action":"list_appointments","from":"…","to":"…","status":"paid"}` | a filtered list (max 500) |
| `{"action":"get_appointment","id":"uuid"}` | one appointment |
| `{"action":"cancel_appointment","id":"uuid"}` | cancels it |

> **`CLINIC_API_KEY` is a password to the whole database.** This function runs as
> `service_role` and bypasses Row Level Security by design. Store it in n8n's
> credential store, never in a workflow node's plain text, and rotate it by
> setting a new secret and updating n8n.

Check it refuses unauthenticated callers before you trust it:

```bash
curl -i -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/clinic-api \
  -H 'Content-Type: application/json' -d '{"action":"list_appointments"}'
# expect: HTTP/2 401
```

---

## Part 4 — Meta Pixel (ads and analytics)

1. **Meta Events Manager → Data Sources →** your pixel → copy the **Pixel ID**
   (15–16 digits).
2. Open [js/analytics.js](js/analytics.js) and replace the placeholder:

```js
window.META_PIXEL_ID = '1234567890123456';
```

That is the whole setup. The pixel is already loaded on every page, and until
you set a real ID it stays dormant and logs a note to the console.

**Two rules are built into the file. Keep them there.**

1. **Nothing loads until the visitor presses Accept.** A consent bar appears on
   the first visit; the pixel script is only injected after an explicit accept.
   Under GDPR — and Egypt's PDPL — advertising trackers need opt-in consent
   *before* they run. The choice is remembered in `localStorage`, and
   `DentalConsent.reset()` reopens it so consent can be withdrawn as easily as
   it was given.

2. **The pixel never runs on private pages.** Booking, payment, login and signup
   are excluded outright, and only a bare `PageView` is ever sent — no service
   name, price, patient name or appointment detail.

A dental clinic is a health provider, and what someone looks at here can reveal
something about their health. Sending "this person booked a root canal" to an ad
platform is the kind of disclosure that has cost other clinics real regulatory
fines. If you later add Meta's Conversions API or advanced matching, keep both
rules.

---

## How the money path is kept safe

| Risk | What stops it |
|---|---|
| Card numbers leaking from the site | The site has **no card fields**. Paymob's iframe collects them. |
| The API key being stolen | It lives only in Edge Function secrets, never in the browser. |
| A patient paying 1 EGP for an implant | The amount is read from the `services` table server-side, never from the request. |
| A faked "payment succeeded" call | The webhook verifies an HMAC-SHA512 signature, and re-checks the charged amount. |
| Reading another patient's records | Row Level Security: every query is filtered to `auth.uid()`. |
| The browser marking itself paid | No insert/update policy exists on `payments`; only the Edge Functions can write it. |

For the full picture — the four layers of security, what each one guarantees,
and the SQL to verify each is actually on — see [SECURITY.md](SECURITY.md).

---

## Still to do

The payment path is written but **has never been run against a live Paymob
account** — it cannot be until the merchant account exists. Test it end to end in
Paymob test mode before taking a real payment, and confirm the callback field
list in `supabase/functions/paymob-webhook/index.ts` still matches the current
Paymob documentation.
