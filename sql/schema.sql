-- DESK ledger (multi-pool fund). Run once in the Supabase SQL editor.

create table if not exists desk_state (
  id text primary key,                       -- DESK_NAME
  wallet text,
  holder_token_mint text,
  ops_wallet text,
  dry_run boolean default true,
  status text default 'running',             -- running | paused | exit-all (closes every pool, then pauses)
  -- pot ledger (all SOL)
  pot_sol numeric default 0,                 -- realized result not yet distributed (can go negative; reserve absorbs)
  fees_total_sol numeric default 0,
  band_pnl_total_sol numeric default 0,
  allocated_total_sol numeric default 0,     -- holder share allocated to wallets
  paid_total_sol numeric default 0,          -- holder share actually transferred
  ops_total_sol numeric default 0,
  reserve_total_sol numeric default 0,       -- share kept as capital
  unpaid_owed_sol numeric default 0,         -- allocated but still under MIN_PAYOUT_SOL per wallet
  -- marks
  equity_sol numeric default 0,
  free_sol numeric default 0,
  deployed_sol numeric default 0,
  open_pools integer default 0,
  candidates jsonb,                          -- scanner shortlist
  -- timing
  last_tick_at timestamptz,
  last_scan_at timestamptz,
  last_payout_at timestamptz,
  next_payout_at timestamptz,
  config jsonb,
  updated_at timestamptz default now()
);

create table if not exists desk_pools (
  desk text not null,
  pool_address text not null,
  token_mint text,
  symbol text,
  status text,                               -- open | closed
  capital_sol numeric default 0,
  sol_leg numeric default 0,
  fees_sol numeric default 0,
  band_pnl_sol numeric default 0,
  entry_price numeric,
  last_price numeric,
  floor_price numeric,
  last_score numeric,
  miss_scans integer default 0,
  bin_step integer,
  position_pubkey text,
  position_lower integer,
  position_upper integer,
  position_cost_sol numeric,
  position_x_in numeric,
  position_y_in numeric,
  position_price_in numeric,
  opened_at timestamptz,
  closed_at timestamptz,
  exit_reason text,                          -- floor | cooled | max-hold | manual
  updated_at timestamptz default now(),
  primary key (desk, pool_address)
);

create table if not exists desk_events (
  id bigserial primary key,
  ts timestamptz default now(),
  desk text not null,
  kind text not null,                        -- boot | scan | pool-enter | rebalance | rebalance-open | harvest | pool-exit | floor | exit-sell | payout | payout-skipped | error
  sol_delta numeric default 0,               -- what this event added to the pot
  price numeric,
  detail jsonb,
  txs text[]
);
create index if not exists desk_events_desk_ts on desk_events (desk, ts desc);

create table if not exists payouts (
  id bigserial primary key,
  ts timestamptz default now(),
  desk text not null,
  total_sol numeric not null,                -- paid to holders this round
  ops_sol numeric default 0,
  wallets integer not null,
  tx_count integer not null,
  dry_run boolean default false,
  pot_before numeric,
  holders_snapshot integer
);

create table if not exists payout_items (
  id bigserial primary key,
  payout_id bigint references payouts(id) on delete cascade,
  wallet text not null,
  amount_sol numeric not null,
  tx text
);
create index if not exists payout_items_wallet on payout_items (wallet);

create table if not exists wallet_owed (
  desk text not null,
  wallet text not null,
  owed_sol numeric default 0,
  paid_sol numeric default 0,
  updated_at timestamptz default now(),
  primary key (desk, wallet)
);

create or replace function accrue_owed(p_desk text, rows jsonb)
returns void language plpgsql as $$
begin
  insert into wallet_owed (desk, wallet, owed_sol, updated_at)
  select p_desk, r->>'wallet', (r->>'sol')::numeric, now()
  from jsonb_array_elements(rows) r
  on conflict (desk, wallet) do update
    set owed_sol = wallet_owed.owed_sol + excluded.owed_sol, updated_at = now();
end $$;

create or replace function mark_paid(p_desk text, rows jsonb)
returns void language plpgsql as $$
begin
  update wallet_owed w
  set owed_sol = greatest(w.owed_sol - (r->>'sol')::numeric, 0),
      paid_sol = w.paid_sol + (r->>'sol')::numeric,
      updated_at = now()
  from jsonb_array_elements(rows) r
  where w.desk = p_desk and w.wallet = r->>'wallet';
end $$;

create or replace view daily_results as
select
  desk,
  (ts at time zone 'utc')::date as day,
  coalesce(sum((detail->>'fees_sol')::numeric) filter (where kind in ('harvest','rebalance','pool-exit','floor')), 0) as fees_sol,
  coalesce(sum((detail->>'band_pnl_sol')::numeric) filter (where kind in ('rebalance','pool-exit','floor','exit-sell')), 0) as band_pnl_sol,
  coalesce(sum((detail->>'holders_paid_sol')::numeric) filter (where kind = 'payout'), 0) as paid_sol,
  coalesce(sum((detail->>'ops_sol')::numeric) filter (where kind = 'payout'), 0) as ops_sol,
  count(*) filter (where kind in ('rebalance','pool-enter')) as rebalances,
  count(*) filter (where kind = 'pool-enter') as pools_entered,
  count(*) filter (where kind in ('pool-exit','floor')) as pools_exited
from desk_events
group by desk, day
order by day desc;

alter table desk_state enable row level security;
alter table desk_pools enable row level security;
alter table desk_events enable row level security;
alter table payouts enable row level security;
alter table payout_items enable row level security;
alter table wallet_owed enable row level security;

drop policy if exists "public read" on desk_state;   create policy "public read" on desk_state   for select using (true);
drop policy if exists "public read" on desk_pools;   create policy "public read" on desk_pools   for select using (true);
drop policy if exists "public read" on desk_events;  create policy "public read" on desk_events  for select using (true);
drop policy if exists "public read" on payouts;      create policy "public read" on payouts      for select using (true);
drop policy if exists "public read" on payout_items; create policy "public read" on payout_items for select using (true);
drop policy if exists "public read" on wallet_owed;  create policy "public read" on wallet_owed  for select using (true);

-- Equity history for the chart (keeper writes one row every SNAPSHOT_INTERVAL_SEC)
create table if not exists equity_snapshots (
  id bigserial primary key,
  ts timestamptz default now(),
  desk text not null,
  equity_sol numeric,
  free_sol numeric,
  deployed_sol numeric,
  pot_sol numeric,
  paid_total_sol numeric,
  open_pools integer
);
create index if not exists equity_snapshots_desk_ts on equity_snapshots (desk, ts desc);
alter table equity_snapshots enable row level security;
drop policy if exists "public read" on equity_snapshots; create policy "public read" on equity_snapshots for select using (true);
