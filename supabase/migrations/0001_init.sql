-- Hedgr initial schema.
-- Tables: markets, pairs, opportunities, positions, price_history.

create table if not exists markets (
  id text primary key, -- '<venue>:<venue_id>'
  venue text not null check (venue in ('polymarket', 'uniswap')),
  venue_id text not null,
  question text not null,
  rules_text text not null default '',
  outcomes jsonb not null default '[]'::jsonb, -- [{ name, price, tokenId? }]
  status text not null default 'active' check (status in ('active', 'closed', 'resolved')),
  end_date timestamptz,
  liquidity_usd numeric,
  updated_at timestamptz not null default now(),
  unique (venue, venue_id)
);

create table if not exists pairs (
  id text primary key,
  market_a_id text not null references markets (id),
  market_b_id text not null references markets (id),
  -- 'confirmed' is set only by human review; the pipeline may only write
  -- 'candidate' or 'flagged'. Unreviewed pairs are never tradable.
  status text not null default 'candidate' check (status in ('confirmed', 'candidate', 'flagged')),
  similarity numeric,
  divergence_prob numeric not null default 0.02 check (divergence_prob >= 0 and divergence_prob <= 1),
  price_if_yes numeric, -- modeled uniswap leg price if the event resolves YES
  price_if_no numeric,  -- modeled uniswap leg price if the event resolves NO
  reviewed_by text,
  notes text,
  created_at timestamptz not null default now(),
  unique (market_a_id, market_b_id)
);

create table if not exists opportunities (
  id text primary key,
  pair_id text not null references pairs (id),
  ev_usd numeric not null,
  max_loss_usd numeric not null,
  fees_usd numeric not null,
  plan jsonb not null,
  computed_at timestamptz not null default now()
);

create index if not exists opportunities_pair_computed_idx
  on opportunities (pair_id, computed_at desc);

create table if not exists positions (
  id text primary key,
  idempotency_key text not null unique,
  pair_id text not null references pairs (id),
  mode text not null check (mode in ('paper', 'live')),
  plan jsonb not null,
  status text not null default 'open' check (status in ('open', 'settled', 'failed')),
  entry jsonb, -- fill prices, tx hashes for live mode
  created_at timestamptz not null default now()
);

create table if not exists price_history (
  id bigint generated always as identity primary key,
  pair_id text references pairs (id),
  market_id text not null references markets (id),
  outcome text not null,
  price numeric not null,
  ts timestamptz not null default now()
);

create index if not exists price_history_pair_ts_idx on price_history (pair_id, ts);
create index if not exists price_history_market_ts_idx on price_history (market_id, ts);
