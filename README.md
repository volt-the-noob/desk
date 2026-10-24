# DESK — a market-making fund that pays your holders

A keeper that puts SOL to work as concentrated liquidity on the hottest Meteora DLMM pools, rotates between them automatically, and splits the result once a day: 50% to holders of your token in SOL, 30% kept as capital, 20% to OPS (operations). Plus a public ledger site.

```
keeper/   Node ESM keeper → Railway (`railway up`)
site/     static ledger dashboard → Vercel (`vercel --prod`)
sql/      Supabase schema (run once)
```

## What it does, on its own

**Every 15 s (tick)** — for each open pool: check price; floor-stop if it fell `FLOOR_PCT_BELOW_ENTRY`% below entry; re-center the band if price left it; harvest fees every `HARVEST_INTERVAL_SEC`. Then: pay out if the clock says so; write marks to the ledger.

**Every 5 min (scan)** — pull every SOL-quoted DLMM pool from Meteora's data API, drop anything blacklisted, under `MIN_TVL_USD`, under `MIN_VOLUME_24H_USD`, younger than `MIN_POOL_AGE_HOURS`, with a freeze authority, or not earning right now (`MIN_FEE_TVL_1H_PCT`). Rank what's left by fees earned per dollar of liquidity (last hour weighted 60%, last 24h 40%). Then:

- **close** any open pool that's been outside the top `2 × MAX_POOLS` for `ROTATE_OUT_SCANS` scans in a row ("cooled"), or held longer than `MAX_HOLD_HOURS`
- **open** the best unopened candidate while seats and capital remain. Seats scale with capital: `clamp(floor(capital / SEAT_SOL), MIN_SEATS, MAX_SEATS)`, so 10 SOL runs 2 seats, 20 runs 5, 50+ runs 8. Capital is split by rank (`SEAT_WEIGHTS`, default 30/22/16/12/8/6/3/3, renormalised to the open seats, no seat above `MAX_SEAT_PCT`); a seat below `MIN_CAPITAL_PER_POOL_SOL` isn't opened

**Every 24 h (payout)** — if the pot is positive: 50% to holders of `HOLDER_TOKEN_MINT` pro rata (wallets under `MIN_PAYOUT_SOL` accrue until they cross it), 20% to `OPS_WALLET` (OPS), 30% stays in the wallet as capital. If the pot is negative, nothing is paid and the loss carries into the next day.

### When a pool gets closed

| reason | trigger | what happens |
|---|---|---|
| `floor` | price < entry × (1 − `FLOOR_PCT_BELOW_ENTRY`%) | close band, sell all of that token in one clip, book the loss |
| `cooled` | outside the scanner's top 2×`MAX_POOLS` for `ROTATE_OUT_SCANS` consecutive scans | close band, sell token (if `EXIT_SELL_INVENTORY`), capital returns to the pool of free SOL |
| `max-hold` | open longer than `MAX_HOLD_HOURS` (0 = never) | same as cooled |
| `manual` | set `desk_state.status = 'exit-all'` in Supabase | every pool closes, then status becomes `paused` |

Capital that comes back is picked up by the next scan.

### Accounting (all SOL)

```
pot += fees harvested                      (per pool, booked as it happens)
pot += band P&L on every close             = (y_out + x_out × price) − cost_basis
pot += realised vs mark on inventory sales (exit / floor slippage)
daily: holders 50% · reserve 30% · ops 20%  → pot resets
negative pot carries forward; the reserve eats it before anyone is paid again
```

SOL owed to holders/ops is always held out of the bands. Fresh SOL arriving in the wallet (creator fees, top-ups) is treated as capital and deployed on the next scan; it never enters the pot.

## Setup

1. **Supabase.** New project → SQL editor → paste `sql/schema.sql` → run. Copy the project URL, `anon` key (site) and `service_role` key (keeper).
2. **Keeper.** `cd keeper && cp .env.example .env`, fill it in, `npm i`, `npm start`. Boots in `DRY_RUN=true`. With `DRY_RUN_SOL=10` it paper-trades a virtual 10 SOL against real pool quotes: you'll see scans, entries, re-centers, exits and simulated payouts in the logs and ledger.
3. **Railway.** `railway up` from `keeper/`, paste the env vars. `/health` and `/state` are on `PORT`.
4. **Site.** Edit the config block at the top of `site/index.html` (Supabase URL, anon key, `DESK_NAME`, your ticker, X link). `vercel --prod` from `site/`.
5. **Go live.** Fund the desk wallet (gas, position rent ~0.06 SOL per pool, holder transfers), set `DRY_RUN=false`, `DRY_RUN_SOL=0`, restart.

## Operating it

- **Pause / resume:** `desk_state.status` → `paused` / `running`. Paused = no band actions, no new pools; marks and payouts continue.
- **Pull everything out:** `desk_state.status` → `exit-all`. Every pool closes and sells; status flips to `paused`.
- **Backtest today's picks:** `npm run backtest -- --capital 20` (add `--flat4` to compare the old equal-weight allocator, `--capture 1.0` for a conservative fee assumption). Uses today's 24h stats to pick (lookahead) and the 24h endpoint move for band P&L; an order-of-magnitude check, not a promise.
- **Pin or ban pools:** `POOL_ALLOWLIST` / `POOL_DENYLIST` / `TOKEN_DENYLIST`, restart.
- **Noise in logs:** the SDK prints a compute-unit simulation error when the wallet is empty (dry-run, unfunded). Harmless.
- **Public RPC:** works for paper trading but 429s on pool loads; a failed entry is retried next scan. Use Helius live.

## Knobs that matter most

| env | default | why |
|---|---|---|
| `FLOOR_PCT_BELOW_ENTRY` | 35 | the only thing between a pool and a rug; lower is safer and churns more |
| `SEAT_SOL` / `MAX_SEATS` | 4 / 8 | seats scale with capital; the best pool gets the biggest seat |
| `SEAT_WEIGHTS` | 30,22,16,12,8,6,3,3 | the 8th-best pool earns far less than the 1st, so it gets a probe, not a quarter |
| `MIN_FEE_TVL_1H_PCT` | 0.3 | the "is it still hot" gate; raise it to be pickier |
| `ROTATE_OUT_SCANS` | 3 | 3 × 5 min = 15 min of cooling before an exit |
| `BINS_BELOW` / `BINS_ABOVE` | 20 / 20 | narrower = more fees per SOL, more re-centers, more realised IL |
| `MIN_POOL_AGE_HOURS` | 6 | skips launch-hour chaos and most instant rugs |

## Honest notes

- The scanner picks pools by how much they *have been* earning. A pool that's hot because it's dumping will be entered and floor-stopped. Expect some of those. The 30% reserve and the floor are the budget for it.
- Dry-run doesn't simulate fees (there are none without a real position), only band P&L from price movement, rotation and the payout mechanics.
- Paying realised profit to holders in SOL is a dividend in all but name. Not legal advice.
- One desk wallet, one position per pool. Don't LP manually from it.
- A pump.fun creator-fee claimer (so your token's creator fees flow into the desk automatically) isn't in yet; needs the token to exist. SOL sent to the wallet by any means is treated as capital today.
