-- =================================================================
-- VIP Partner programme - Supabase schema
-- Run this once in the Supabase SQL editor (Project > SQL Editor).
-- All access to partners/referrals/payouts goes through Cloud
-- Functions using the service_role key - the anon key (used in the
-- browser) never touches these tables directly, so RLS is left
-- enabled with no policies (default deny) for anon/authenticated.
-- =================================================================

-- Already exists (Instagram invite allow-list, checked client-side
-- with the anon key - keep its existing SELECT policy as-is):
--   invited_partners (instagram_handle text)

create extension if not exists pgcrypto;

create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  instagram_handle text,
  discount_code text unique,
  course_date text,
  attended boolean not null default false,
  bank_account_name text,
  bank_sort_code text,
  bank_account_number text,
  login_token text,
  login_token_expiry bigint,
  created_at timestamptz not null default now()
);

-- One row per booking made with a VIP partner's discount code.
-- workshop_date is the referred customer's chosen workshop date
-- (from the workshops collection's sortDate field) - payouts only
-- count a referral once this date has passed, to confirm attendance.
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  discount_code text not null,
  customer_name text,
  customer_email text,
  stripe_session_id text unique,
  workshop_date date,
  created_at timestamptz not null default now()
);

-- Safe to re-run: adds the column if this table already existed
-- before workshop_date was introduced.
alter table referrals add column if not exists workshop_date date;

-- One row per payout actually made to a partner.
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  amount numeric not null,
  payout_date date not null,
  paid boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists referrals_partner_id_idx on referrals(partner_id);
create index if not exists payouts_partner_id_idx on payouts(partner_id);

alter table partners enable row level security;
alter table referrals enable row level security;
alter table payouts enable row level security;
-- No policies added - only the service_role key (used server-side in
-- Cloud Functions) can read/write these tables, bypassing RLS.
