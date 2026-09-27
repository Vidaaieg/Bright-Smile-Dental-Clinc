-- ===========================================================================
-- Bright Smile Clinic — security hardening (LAYER 3: the database itself)
--
-- Run this AFTER schema.sql, in the Supabase SQL editor.
-- Safe to re-run.
--
-- schema.sql sets up who can read which rows (Layer 2, RLS). This file is
-- about the data itself: making bad data impossible to store, restricting
-- what the public API role can touch, and keeping a tamper-evident record of
-- who changed what.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Least privilege on the API roles
--
-- Supabase exposes two Postgres roles through PostgREST: `anon` (not logged
-- in) and `authenticated`. By default they get broad table access and RLS is
-- the only thing holding them back. Belt and braces: take away the grants
-- they should never need, so a mistaken or missing policy is not enough on
-- its own to leak data.
-- ---------------------------------------------------------------------------

-- Nobody reaching the database over HTTP may create tables.
revoke create on schema public from anon, authenticated;

-- The price list is read-only from the web, for everyone.
revoke insert, update, delete on public.services from anon, authenticated;

-- Payments are written only by Edge Functions (service_role).
revoke insert, update, delete on public.payments from anon, authenticated;

-- Not-logged-in visitors get nothing but the price list.
revoke all on public.profiles     from anon;
revoke all on public.appointments from anon;
revoke all on public.payments     from anon;

-- Appointments are never hard-deleted from the browser; they are cancelled.
revoke delete on public.appointments from authenticated;
revoke delete on public.profiles     from authenticated;


-- ---------------------------------------------------------------------------
-- 2. Constraints — make invalid data impossible, not just unlikely
--
-- The browser already validates these. That validation is a convenience for
-- honest users; it is not a control, because anyone can bypass it. These
-- constraints are the actual control.
-- ---------------------------------------------------------------------------

alter table public.appointments
   drop constraint if exists appointments_email_format;
alter table public.appointments
   add constraint appointments_email_format
   check (patient_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

alter table public.appointments
   drop constraint if exists appointments_phone_format;
alter table public.appointments
   add constraint appointments_phone_format
   check (patient_phone ~ '^[+0-9][0-9 ()\-]{6,24}$');

alter table public.appointments
   drop constraint if exists appointments_name_length;
alter table public.appointments
   add constraint appointments_name_length
   check (char_length(trim(patient_name)) between 2 and 120);

-- No booking more than a year out — a sign of a script, not a patient.
alter table public.appointments
   drop constraint if exists appointments_reasonable_date;
alter table public.appointments
   add constraint appointments_reasonable_date
   check (scheduled_at < now() + interval '1 year');


-- ---------------------------------------------------------------------------
-- 3. No double booking, and no flooding the calendar
--
-- Enforced in a trigger rather than the browser, because the browser is not
-- a place where rules can be enforced.
-- ---------------------------------------------------------------------------

-- One appointment per slot: two patients cannot hold the same time.
create unique index if not exists appointments_unique_slot
   on public.appointments (scheduled_at)
   where status <> 'cancelled';

create or replace function public.check_booking_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
   recent_count integer;
   pending_count integer;
begin
   -- Rate limit: at most 5 bookings per patient per hour.
   select count(*) into recent_count
   from public.appointments
   where user_id = new.user_id
     and created_at > now() - interval '1 hour';

   if recent_count >= 5 then
      raise exception 'Too many bookings in a short time. Please try again later.'
         using errcode = 'check_violation';
   end if;

   -- At most 3 unpaid appointments held at once, so the calendar cannot be
   -- blocked out by someone who never pays.
   select count(*) into pending_count
   from public.appointments
   where user_id = new.user_id
     and status = 'pending_payment'
     and scheduled_at > now();

   if pending_count >= 3 then
      raise exception 'You already have 3 unpaid appointments. Please pay or cancel one first.'
         using errcode = 'check_violation';
   end if;

   return new;
end;
$$;

drop trigger if exists appointments_booking_limits on public.appointments;
create trigger appointments_booking_limits
   before insert on public.appointments
   for each row execute function public.check_booking_limits();


-- ---------------------------------------------------------------------------
-- 4. Audit log — a record of every change to money and bookings
--
-- Append-only. Nothing in the API roles can read, edit or delete it; only
-- service_role and the dashboard can. If something goes wrong, this is how
-- you find out what actually happened.
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
   id          bigserial primary key,
   table_name  text        not null,
   operation   text        not null,
   row_id      text,
   actor       uuid,
   old_data    jsonb,
   new_data    jsonb,
   created_at  timestamptz not null default now()
);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
-- No policy is created on purpose: with RLS on and no policy, every request
-- through the API is denied. service_role bypasses RLS and can still read it.

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
   insert into public.audit_log (table_name, operation, row_id, actor, old_data, new_data)
   values (
      tg_table_name,
      tg_op,
      coalesce(new.id::text, old.id::text),
      auth.uid(),
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end
   );
   return coalesce(new, old);
end;
$$;

drop trigger if exists audit_appointments on public.appointments;
create trigger audit_appointments
   after insert or update or delete on public.appointments
   for each row execute function public.write_audit_log();

drop trigger if exists audit_payments on public.payments;
create trigger audit_payments
   after insert or update or delete on public.payments
   for each row execute function public.write_audit_log();


-- ---------------------------------------------------------------------------
-- 5. Keep updated_at honest
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
   new.updated_at = now();
   return new;
end;
$$;

drop trigger if exists payments_touch_updated_at on public.payments;
create trigger payments_touch_updated_at
   before update on public.payments
   for each row execute function public.touch_updated_at();


-- ===========================================================================
-- Verification — run these and read the output, do not assume it worked
-- ===========================================================================

-- Every public table must show rowsecurity = true:
--   select tablename, rowsecurity from pg_tables where schemaname = 'public';

-- Every policy, so you can see exactly who can do what:
--   select tablename, policyname, cmd, qual from pg_policies where schemaname='public';

-- Tables with RLS on but NO policy at all are fully locked (audit_log should
-- be the only one here):
--   select t.tablename from pg_tables t
--   left join pg_policies p on p.tablename = t.tablename
--   where t.schemaname = 'public' and t.rowsecurity and p.policyname is null;
