# DESK launch runbook

Order: **creator-fee income + pool desk from launch → stock desk from day 2** (only if its paper log shows real, executable trades).

Pool desk risk limits (Railway): POOL_MAX_CAPITAL_SOL=5 · POOL_BREAKER_PCT=5 over POOL_BREAKER_DAYS=7 (closes every seat, pauses 24h) ·
POOL_VERIFIED_ONLY=true · MIN_POOL_AGE_HOURS=168 · MIN_TVL_USD=100000 · MAX_RANGE_24H=1.05 · MAX_SEATS=3 · FLOOR 12%.
Only the reserve share of fees is ever deployed; holder, OPS and buyback shares stay in SOL until paid.

Venues: Meteora DLMM (concentrated bands) and PumpSwap (full range), both sleeves; one seat per coin, on whichever venue pays
better. Jupiter is only used for coin data (verified list, holders, organic score) and swap routing (buybacks via PumpSwap).
All pool transactions simulated on mainnet: Meteora open/swap/claim/close; PumpSwap buy/add/sell/withdraw.

Pool desk size follows the treasury: POOL_ALLOC_PCT=70% of equity minus what's owed to holders/OPS/buybacks and gas.
No fixed SOL cap and no seat limit: seats are added as capital grows (one per 4 SOL, none bigger than 25 SOL).
Split into two sleeves:
- calm 60% of that budget: verified, ≥7d old, ≥$100k TVL, moved <5%/24h, 12% floor · breaker −5% of the sleeve / 7d → pause 24h
- meme 40% of that budget (MEME_SHARE_PCT): ≥$500k mcap, ≥$500k 24h volume, ≥1,500 holders, Jupiter organic score ≥50, mint+freeze
  authority off, top-10 holders ≤35%, dev ≤10%, ≥$20k pool liquidity · max 2 seats · 10% trailing stop, 6h max hold, 12% floor ·
  breaker −20% of the sleeve / 7d → pause 48h. Backtests of busy meme pools were negative in every variant; this sleeve is
  the high-risk part and its losses come out of the pot before payouts. MEME_SHARE_PCT=0 turns it off.

## Now (rehearsal, before launch)
Railway variables are already set to the rehearsal profile:
`DRY_RUN=true · STOCK_MODE=live · STOCK_CAPITAL_SOL=10 · STOCK_TICKERS=NVDA,TSLA,SPY,AAPL · POOLS_ENABLED=false`
The stock desk funds a simulated book and trades it on executable Jupiter quotes during US market hours
(13:30–20:00 UTC, Mon–Fri). Every trade lands in the ledger and on the site exactly as it will live.

## Launch day
1. Launch on pump.fun. Set creator fee sharing: **85% → the DESK wallet**, 15% → OPS wallet. The keeper distributes the fees itself
   (at $100 waiting or every 5 minutes) and books the desk's share into the pot. No income wallet needed.
2. Railway variables:
   - `HOLDER_TOKEN_MINT=<CA>` · `OPS_WALLET=<ops>` (INCOME_WALLET_SECRET stays empty)
   - `POOLS_ENABLED=true` (already set) · `POOLS_START_AT` empty
   - `OPS_SHARE_PCT=0` and add those 20 points to holders or reserve (OPS is already paid at the source)
   - `DRY_RUN=false` when you are ready to trade real funds
3. Fund the desk wallet: STOCK_CAPITAL_SOL (default 10) + pool capital + 0.2 SOL gas.
4. Site `index.html` config: `CONTRACT_ADDRESS`, `X_URL`.

## Keys
- `RPC_URL`: Helius (required for holder snapshots and reliable sends)
- `FINNHUB_KEY` + `STOCK_REF_SOURCE=finnhub`: the real stock price the desk trades against
- At launch: wipe the rehearsal ledger so the payout clock and stats start at zero

## Day 2
Stock desk: check its paper log first (trades it would have made at executable prices). Today's live measurement found no
gaps above 0.034%; if that's still true, leave STOCK_MODE=paper. Switch to STOCK_MODE=live only if the log shows real trades.

## Kill switches
- `STOCK_MODE=paper` stops stock trading (open trades stay; set back to live to resume and close them)
- `POOLS_ENABLED=false` stops new pool seats; `status=exit-all` in `desk_state` closes every pool seat
