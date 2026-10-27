# DESK launch runbook

Order: **stock desk + creator-fee income from launch → liquidity (pool) desk from day 2.**

## Now (rehearsal, before launch)
Railway variables are already set to the rehearsal profile:
`DRY_RUN=true · STOCK_MODE=live · STOCK_CAPITAL_SOL=10 · STOCK_TICKERS=NVDA,TSLA,SPY,AAPL · POOLS_ENABLED=false`
The stock desk funds a simulated book and trades it on executable Jupiter quotes during US market hours
(13:30–20:00 UTC, Mon–Fri). Every trade lands in the ledger and on the site exactly as it will live.

## Launch day
1. Launch on pump.fun. Set creator fee sharing: 85% → INCOME wallet, 15% → OPS wallet.
2. Railway variables:
   - `HOLDER_TOKEN_MINT=<CA>` · `OPS_WALLET=<ops>` · `INCOME_WALLET_SECRET=<key of the 85% wallet>`
   - `POOLS_ENABLED=true` · `POOLS_START_AT=<launch time + 24h, ISO, e.g. 2026-11-03T15:00:00Z>`
   - `OPS_SHARE_PCT=0` and add those 20 points to holders or reserve (OPS is already paid at the source)
   - `DRY_RUN=false` when you are ready to trade real funds
3. Fund the desk wallet: STOCK_CAPITAL_SOL (default 10) + pool capital + 0.2 SOL gas.
4. Site `index.html` config: `CONTRACT_ADDRESS`, `X_URL`.

## Day 2
Nothing to do: the pool desk switches itself on at POOLS_START_AT and the site's countdown turns into live seats.

## Kill switches
- `STOCK_MODE=paper` stops stock trading (open trades stay; set back to live to resume and close them)
- `POOLS_ENABLED=false` stops new pool seats; `status=exit-all` in `desk_state` closes every pool seat
