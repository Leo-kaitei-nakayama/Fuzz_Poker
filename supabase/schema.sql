-- Cute Poker — PostgreSQL / Supabase schema (SPEC §8).
--
-- The Phase 1 game server ships with an embedded SQLite store (see
-- apps/game-server/src/store) so it runs with zero external dependencies. This
-- file is the production target: run it against Supabase/Postgres and implement
-- a PostgresStore satisfying the same Store interface to switch over.
--
-- Principle (SPEC §8, §4.4): coin and character writes go through the server
-- (service role) only. Row Level Security blocks all direct client writes.

create extension if not exists "pgcrypto";

-- ---- users --------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  display_name    text unique not null,
  email           text,
  main_character_id uuid,
  timezone        text not null default 'UTC',
  is_bot          boolean not null default false,
  bot_difficulty  text check (bot_difficulty in ('easy','normal','hard')),
  avatar_emoji    text not null default '🐱',
  created_at      timestamptz not null default now(),
  banned_at       timestamptz
);

-- ---- wallet + ledger (SPEC §4.4) ---------------------------------------
create table if not exists wallets (
  user_id    uuid primary key references users(id) on delete cascade,
  balance    bigint not null check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists coin_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  amount          bigint not null,            -- + gain / - spend
  balance_after   bigint not null,
  reason          text not null,              -- signup_bonus, daily_login, table_buyin, table_cashout, shop_purchase, trade_fee, trade_in, trade_out, ad_reward
  ref_type        text,
  ref_id          uuid,
  meta            jsonb,                      -- {raw, factor} etc. (SPEC §4.5)
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);
create index if not exists coin_tx_user_idx on coin_transactions(user_id, created_at);

-- Chips destroyed/injected by the x0.2 bot reflection, for inflation stats (SPEC §4.5).
create table if not exists coin_sink (
  id               uuid primary key default gen_random_uuid(),
  hand_id          uuid not null,
  user_id          uuid not null references users(id),
  raw_amount       bigint not null,
  factor           numeric not null,
  destroyed_amount bigint not null,
  created_at       timestamptz not null default now()
);

-- ---- daily login (SPEC §4.2) -------------------------------------------
create table if not exists daily_logins (
  user_id    uuid not null references users(id),
  login_date date not null,
  streak     int not null,
  reward     int not null,
  primary key (user_id, login_date)
);

-- ---- characters (SPEC §5 — Phase 2) ------------------------------------
create table if not exists character_types (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name_ja      text, name_en text, name_zh text,
  description_ja text,
  rarity       text check (rarity in ('N','R','SR','SSR')),
  series       text,
  image_url    text,
  expression_urls jsonb,
  shop_price   bigint,                        -- null = not for sale
  is_tradable  boolean not null default true,
  is_active    boolean not null default true,
  max_supply   int
);

create table if not exists owned_characters (
  id               uuid primary key default gen_random_uuid(),
  type_id          uuid not null references character_types(id),
  owner_id         uuid references users(id),
  serial_number    int,
  acquired_at      timestamptz not null default now(),
  acquired_via     text,                      -- shop, trade, default, event
  locked_by_trade_id uuid
);

alter table users
  add constraint users_main_character_fk
  foreign key (main_character_id) references owned_characters(id)
  deferrable initially deferred;

-- ---- trades (SPEC §6 — Phase 3) ----------------------------------------
create table if not exists trades (
  id                 uuid primary key default gen_random_uuid(),
  proposer_id        uuid not null references users(id),
  recipient_id       uuid not null references users(id),
  status             text not null,           -- PENDING, COUNTERED, ACCEPTED_BY_RECIPIENT, COMPLETED, REJECTED, CANCELLED, EXPIRED
  proposer_coins     bigint not null default 0,
  recipient_coins    bigint not null default 0,
  message            text,
  expires_at         timestamptz,
  proposer_confirmed boolean not null default false,
  recipient_confirmed boolean not null default false,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create table if not exists trade_items (
  trade_id           uuid not null references trades(id) on delete cascade,
  owned_character_id uuid not null references owned_characters(id),
  side               text not null check (side in ('proposer','recipient'))
);

-- ---- poker tables + hand history (SPEC §8) -----------------------------
create table if not exists tables (
  id         text primary key,
  name       text not null,
  sb         int not null,
  bb         int not null,
  min_buyin  bigint not null,
  max_buyin  bigint not null,
  max_seats  int not null,
  is_active  boolean not null default true
);

create table if not exists hand_history (
  id                uuid primary key default gen_random_uuid(),
  table_id          text not null,
  hand_number       bigint not null,
  started_at        timestamptz not null,
  players           jsonb not null,
  actions           jsonb not null,
  board             jsonb not null,
  pot_results       jsonb not null,
  bots_present      boolean not null default false,
  reflection_factor numeric not null default 1.0,
  rng_seed_hash     text                       -- provable fairness (SPEC §9.3)
);
create index if not exists hand_history_table_idx on hand_history(table_id, hand_number);

-- ---- moderation (SPEC §6.4, §10.3) -------------------------------------
create table if not exists blocks (
  blocker_id uuid not null references users(id),
  blocked_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
create table if not exists reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid not null references users(id),
  target_user_id uuid not null references users(id),
  reason         text,
  ref_type       text,
  ref_id         uuid,
  status         text not null default 'open',
  created_at     timestamptz not null default now()
);

-- ---- Row Level Security (SPEC §8) --------------------------------------
-- Enable RLS everywhere; the server uses the service role (which bypasses RLS).
-- Clients may read their own rows but never write coin/character data directly.
alter table users             enable row level security;
alter table wallets           enable row level security;
alter table coin_transactions enable row level security;
alter table coin_sink         enable row level security;
alter table daily_logins      enable row level security;
alter table character_types   enable row level security;
alter table owned_characters  enable row level security;
alter table trades            enable row level security;
alter table trade_items       enable row level security;
alter table hand_history      enable row level security;
alter table blocks            enable row level security;
alter table reports           enable row level security;

-- Example read policies (uncomment and adapt once Supabase Auth is wired):
-- create policy "own wallet readable" on wallets for select using (auth.uid() = user_id);
-- create policy "own ledger readable" on coin_transactions for select using (auth.uid() = user_id);
-- create policy "active character catalog readable" on character_types for select using (is_active);
