-- MESH schema for Supabase (run in Supabase SQL Editor)
create table if not exists public.peers (
  address text primary key,
  skills jsonb,
  min_fee numeric,
  response_time text,
  reputation integer,
  stake numeric,
  stake_age_seconds bigint,
  reply_chat text,
  last_seen bigint,
  created_at bigint,
  updated_at bigint
);

create table if not exists public.intents (
  id text primary key,
  from_address text,
  skill text,
  payload jsonb,
  budget numeric,
  deadline bigint,
  min_reputation integer,
  status text,
  created_at bigint,
  accepted_offer_id text,
  selected_executor text,
  updated_at bigint
);

create table if not exists public.deals (
  intent_id text primary key,
  executor_address text,
  fee numeric,
  tx_hash text,
  outcome text,
  rating integer,
  settled_at bigint,
  updated_at bigint
);

create table if not exists public.offers (
  id text primary key,
  intent_id text,
  from_address text,
  fee numeric,
  fee_raw text,
  eta text,
  reputation integer,
  stake_age_seconds bigint,
  escrow_address text,
  created_at bigint
);

create table if not exists public.processed_messages (
  message_key text primary key,
  message_type text,
  source_chat_id text,
  source_message_id text,
  payload_hash text,
  first_seen_at bigint
);

create index if not exists idx_peers_last_seen on public.peers(last_seen desc);
create index if not exists idx_intents_status_deadline on public.intents(status, deadline);
create index if not exists idx_offers_intent_created on public.offers(intent_id, created_at);
create index if not exists idx_deals_settled_at on public.deals(settled_at desc);

-- For service role usage via PostgREST, RLS can remain enabled; service role bypasses it.
-- If you plan to use anon/authenticated keys, define explicit RLS policies instead.
