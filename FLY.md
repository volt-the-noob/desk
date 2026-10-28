# Running the DESK keeper on Fly.io (Solana launch)

One always-on Node process. All state lives in Supabase, so the machine is disposable: if it dies, Fly
restarts it and the desk carries on exactly where it left off.

Everything below is run from your own machine, in the `keeper` folder of the repo.

---

## 1. Install the CLI and sign up

macOS / Linux:
```bash
curl -L https://fly.io/install.sh | sh
```
Windows (PowerShell):
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

```bash
fly auth signup        # or: fly auth login
```
A card is required at signup for anti-abuse, but the small machine we use costs nothing on the free allowance.

---

## 2. Create the app (does not deploy yet)

```bash
cd desk/keeper
fly launch --no-deploy --copy-config --name desk-keeper --region iad
```
`fly.toml` and `Dockerfile` are already in this folder, so it uses them. Say **no** to Postgres, Redis and
every other add-on it offers — we use Supabase.

If the name is taken, pick another and remember it (`--name desk-keeper-volt`).

---

## 3. Secrets — the four that must not go through chat

```bash
fly secrets set \
  WALLET_SECRET='<desk wallet private key, base58 or [1,2,3…]>' \
  SUPABASE_SERVICE_KEY='<Supabase → Project Settings → API → service_role>' \
  RPC_URL='https://mainnet.helius-rpc.com/?api-key=<your key>' \
  FINNHUB_KEY='<finnhub.io key>'
```
Quote each value. If a value contains a `$` or a space, single quotes keep the shell from eating it.

---

## 4. Settings

```bash
fly secrets set \
  CHAIN=solana \
  SUPABASE_URL=https://cyahngfggbiaycarjseg.supabase.co \
  DESK_NAME=desk \
  DRY_RUN=true DRY_RUN_SOL=20 \
  HOLDER_SHARE_PCT=50 RESERVE_SHARE_PCT=30 OPS_SHARE_PCT=20 BUYBACK_SHARE_PCT=0 \
  PAYOUT_INTERVAL_HOURS=24 PAYOUT_THRESHOLD_SOL=0 MIN_PAYOUT_SOL=0.002 \
  CLAIM_ENABLED=true CLAIM_CHECK_SEC=60 CLAIM_MIN_USD=100 CLAIM_INTERVAL_SEC=300 CLAIM_DUST_SOL=0.005 \
  POOLS_ENABLED=true POOL_ALLOC_PCT=70 POOL_MAX_CAPITAL_SOL=0 POOL_VERIFIED_ONLY=true \
  POOL_BREAKER_PCT=5 POOL_BREAKER_DAYS=7 POOL_BREAKER_PAUSE_HOURS=24 \
  MEME_SHARE_PCT=40 MEME_MIN_SEATS=3 MEME_SEAT_SOL_MAX=8 MEME_MAX_SEATS=0 \
  MEME_MIN_MCAP_USD=500000 MEME_MIN_VOLUME_USD=500000 MEME_MIN_LIQ_USD=20000 \
  MEME_MIN_HOLDERS=1500 MEME_MIN_ORGANIC=50 MEME_MAX_TOP_HOLDERS_PCT=35 \
  MEME_TRAIL_PCT=10 MEME_MAX_HOLD_HOURS=6 MEME_FLOOR_PCT=12 \
  MEME_BREAKER_PCT=20 MEME_BREAKER_PAUSE_HOURS=48 \
  MAX_RANGE_24H=1.05 MIN_TVL_USD=100000 MIN_POOL_AGE_HOURS=168 MIN_VOLUME_24H_USD=300000 \
  MIN_FEE_TVL_1H_PCT=0 MIN_CAPITAL_PER_POOL_SOL=1.0 MAX_SEATS=0 SEAT_SOL=4 SEAT_SOL_MAX=25 \
  BINS_BELOW=34 BINS_ABOVE=34 FLOOR_PCT_BELOW_ENTRY=12 ROTATE_OUT_SCANS=72 \
  GAS_RESERVE_SOL=0.05 GAS_MIN_SOL=0.004 SCAN_INTERVAL_SEC=300 HARVEST_INTERVAL_SEC=300 \
  SNAPSHOT_INTERVAL_SEC=900 TICK_MS=15000 STRATEGY=Spot ENTRY_MODE=balanced REBALANCE_MODE=inventory \
  STOCK_MODE=paper STOCK_TICKERS=NVDA,TSLA,SPY,AAPL STOCK_REF_SOURCE=finnhub \
  STOCK_TICK_SEC=30 STOCK_ENTER_PCT=0.4 STOCK_CLIP_USD=0 STOCK_MIN_CLIP_USD=15 \
  JUP_MIN_INTERVAL_MS=1100 JUP_MAX_PRIORITY_LAMPORTS=200000
```
Fly stores all of these as secrets, which is fine — to the app they are just environment variables.

---

## 5. Deploy

```bash
fly deploy
```
First build takes a few minutes. Then:
```bash
fly logs                                   # live output — this is what to paste me
fly status                                 # machine state
curl https://desk-keeper.fly.dev/health    # {"ok":true,...}
curl https://desk-keeper.fly.dev/state     # full desk state
```

**What a healthy boot looks like:** `fund booted`, then `scan: calm pools …`, then harvests every few
minutes. Warnings about the token mint and OPS wallet are expected until launch.

---

## 6. At launch

```bash
fly secrets set \
  HOLDER_TOKEN_MINT=<the coin's mint> \
  OPS_WALLET=<your OPS wallet> \
  DRY_RUN=false
```
Each `fly secrets set` restarts the machine automatically — no redeploy needed.

---

## Day-to-day

| what | command |
|---|---|
| live logs | `fly logs` |
| restart | `fly apps restart desk-keeper` |
| stop trading now | `fly secrets set POOLS_ENABLED=false` |
| full stop | `fly scale count 0` (and `fly scale count 1` to resume) |
| what's set | `fly secrets list` (names only, never values) |
| roll back | `fly releases` then `fly deploy --image <older image>` |

## Notes
- `auto_stop_machines = false` and `min_machines_running = 1` in fly.toml are deliberate: a sleeping
  keeper misses fee claims and the daily payout.
- A restart mid-payout is safe. Each wallet is marked paid in the ledger as its transfer lands, so a
  resumed run never pays anyone twice.
- 512MB is the right size; 256MB gets tight once the holder index is warm.
