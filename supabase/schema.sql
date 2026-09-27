-- ===========================================================================
-- Bright Smile Clinic — Supabase schema
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It is safe to re-run: every statement is guarded.
--
-- Security model
--   * Row Level Security is ON for every table. Nothing is readable by
--     default; each policy below grants the narrowest access that works.
--   * Patients can only ever see their OWN appointments and payments.
--   * Prices live in the `services` table, NOT in the browser. The payment
--     Edge Function reads the price from here, so a patient cannot change
--     what they are charged by editing the page.
--   * The `payments` table is written only by the Edge Functions, which use
--     the service_role key. The browser can read its own rows but never
--     insert or update them.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- profiles — one row per patient, created automatically on sign up
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
   id          uuid primary key references auth.users on delete cascade,
   first_name  text,
   last_name   text,
   phone       text,
   address     text,
   created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
   on public.profiles for select
   using (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
   on public.profiles for update
   using (auth.uid() = id)
   with check (auth.uid() = id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own"
   on public.profiles for insert
   with check (auth.uid() = id);


-- Copy the sign-up metadata into profiles the moment an account is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
   insert into public.profiles (id, first_name, last_name, phone, address)
   values (
      new.id,
      new.raw_user_meta_data ->> 'first_name',
      new.raw_user_meta_data ->> 'last_name',
      new.raw_user_meta_data ->> 'phone',
      new.raw_user_meta_data ->> 'address'
   )
   on conflict (id) do nothing;
   return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
   after insert on auth.users
   for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- services — the price list. THIS is the source of truth for what to charge.
-- ---------------------------------------------------------------------------

create table if not exists public.services (
   slug            text primary key,
   name_en         text not null,
   name_ar         text,
   name_de         text,
   name_ru         text,
   -- Paymob works in piastres: 1 EGP = 100 piastres. 50000 = 500.00 EGP.
   price_piastres  integer not null check (price_piastres >= 0),
   is_active       boolean not null default true
);

alter table public.services enable row level security;

-- The price list is public: anyone may read it, nobody may write it from the
-- browser. Change prices in the Supabase dashboard.
drop policy if exists "services: public read" on public.services;
create policy "services: public read"
   on public.services for select
   using (is_active);


-- >>> PLACEHOLDER PRICES — replace these with the clinic's real prices <<<
insert into public.services (slug, name_en, name_ar, name_de, name_ru, price_piastres) values
   ('consultation',        'Consultation',          'استشارة',              'Beratung',                    'Консультация',                30000),
   ('alignment',           'Alignment specialist',  'تقويم الأسنان',        'Kieferorthopädie',            'Исправление прикуса',       1500000),
   ('cosmetic-dentistry',  'Cosmetic dentistry',    'طب الأسنان التجميلي',  'Ästhetische Zahnmedizin',      'Эстетическая стоматология',  400000),
   ('oral-hygiene',        'Oral hygiene experts',  'تنظيف وصحة الفم',      'Professionelle Zahnreinigung', 'Профессиональная гигиена',    80000),
   ('root-canal',          'Root canal specialist', 'علاج جذور الأسنان',    'Wurzelkanalbehandlung',        'Лечение каналов',            250000),
   ('dental-advisory',     'Live dental advisory',  'استشارة عن بُعد',      'Online-Beratung',              'Онлайн-консультация',         15000),
   ('cavity-inspection',   'Cavity inspection',     'فحص التسوس',           'Kariesuntersuchung',           'Диагностика кариеса',         50000),
   ('pediatric-dentistry', 'Pediatric dentistry',   'طب أسنان الأطفال',     'Kinderzahnheilkunde',          'Детская стоматология',        60000),
   ('dental-implants',     'Dental implants',       'زراعة الأسنان',        'Zahnimplantate',               'Имплантация зубов',         2000000)
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------

create table if not exists public.appointments (
   id            uuid primary key default gen_random_uuid(),
   user_id       uuid not null references auth.users on delete cascade,
   service_slug  text not null references public.services (slug),
   scheduled_at  timestamptz not null,
   patient_name  text not null,
   patient_email text not null,
   patient_phone text not null,
   -- pending_payment → paid → (cancelled)
   status        text not null default 'pending_payment'
                 check (status in ('pending_payment', 'paid', 'cancelled')),
   created_at    timestamptz not null default now()
);

create index if not exists appointments_user_idx on public.appointments (user_id, scheduled_at desc);

alter table public.appointments enable row level security;

drop policy if exists "appointments: read own" on public.appointments;
create policy "appointments: read own"
   on public.appointments for select
   using (auth.uid() = user_id);

-- A patient may only book in their own name, and only in the future.
drop policy if exists "appointments: insert own" on public.appointments;
create policy "appointments: insert own"
   on public.appointments for insert
   with check (auth.uid() = user_id and scheduled_at > now());

-- Patients may cancel, but may NOT mark anything paid — only the Edge
-- Function (service_role) can do that, after Paymob confirms.
drop policy if exists "appointments: cancel own" on public.appointments;
create policy "appointments: cancel own"
   on public.appointments for update
   using (auth.uid() = user_id)
   with check (auth.uid() = user_id and status in ('pending_payment', 'cancelled'));


-- ---------------------------------------------------------------------------
-- payments — written only by the Edge Functions
-- ---------------------------------------------------------------------------

create table if not exists public.payments (
   id                uuid primary key default gen_random_uuid(),
   appointment_id    uuid not null references public.appointments on delete cascade,
   user_id           uuid not null references auth.users on delete cascade,
   amount_piastres   integer not null check (amount_piastres >= 0),
   currency          text not null default 'EGP',
   provider          text not null default 'paymob',
   provider_order_id text,
   provider_txn_id   text,
   status            text not null default 'pending'
                     check (status in ('pending', 'paid', 'failed', 'refunded')),
   created_at        timestamptz not null default now(),
   updated_at        timestamptz not null default now()
);

create unique index if not exists payments_order_idx
   on public.payments (provider, provider_order_id)
   where provider_order_id is not null;

create index if not exists payments_user_idx on public.payments (user_id, created_at desc);

alter table public.payments enable row level security;

-- Read-only from the browser. No insert/update policy exists on purpose:
-- without one, RLS denies those actions to every normal user.
drop policy if exists "payments: read own" on public.payments;
create policy "payments: read own"
   on public.payments for select
   using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify: this should list one policy per line, and rowsecurity = true.
-- ---------------------------------------------------------------------------
-- select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- select tablename, policyname, cmd from pg_policies where schemaname = 'public';
