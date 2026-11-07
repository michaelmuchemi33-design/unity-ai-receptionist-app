-- TWIGA workspace identity for Cloudflare-backed operational storage.
-- Kept separate from legacy twiga_customers/licence billing until records are reconciled.
create extension if not exists pgcrypto;

create table if not exists public.twiga_business_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  legacy_customer_id uuid unique references public.twiga_customers(id) on delete restrict,
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','suspended','closed'))
);

create table if not exists public.twiga_business_memberships (
  business_id uuid not null references public.twiga_business_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','manager','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (business_id,user_id)
);
create index if not exists twiga_memberships_user_idx on public.twiga_business_memberships(user_id,business_id);

alter table public.twiga_business_workspaces enable row level security;
alter table public.twiga_business_memberships enable row level security;
revoke all on public.twiga_business_workspaces,public.twiga_business_memberships from anon,authenticated;
-- The Worker uses the Supabase service role after validating the caller's Auth JWT.
-- Client-side writes are intentionally disabled to keep workspace membership server-controlled.

-- Explicitly grant the trusted Worker role access; browser roles remain denied.
grant all on public.twiga_business_workspaces, public.twiga_business_memberships to service_role;
