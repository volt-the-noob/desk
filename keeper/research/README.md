# Strategy research (Oct 2026)

| strategy | data | result on ~20 SOL |
|---|---|---|
| Memecoin LP bands (Meteora DLMM), 11 families + 6,480-combo grid | 2 × 48h walk-forward | no config profitable from fees in both windows |
| PumpSwap full range | 2 × 48h | positive only via one coin pumping (REMUS); realised −2.1 SOL |
| Funding carry (spot + short HL perp) | 100h HL funding | funding at 11% APR floor; −$3 to −$13 per 48h after costs |
| **xStock reference arb** (tokenized stocks vs real price) | 1-minute bars, 2 sessions | **+$15 to +$174 per session**, positive in both, every setting |

Run: `python3 xarb1m.py` (today) / `python3 xarb1m_fri.py` (Friday). Caveats: pool prices are last trades, not executable quotes;
P&L is spread capture (stock moves while holding are not hedged); competition at scale unknown. Validate with live paper trading
on executable Jupiter quotes vs Pyth equity feeds before funding.

## Oct 27: pool desk, calm-pool rule (the one that held up)
- Mainnet simulation of every pool-desk transaction (open, in-pool swap, claim, 3-tx close on a live position): all OK.
- Ranking by raw fees picks the most volatile coins: −58% / −39% over two 48h windows.
- Ranking by fees ÷ volatility, only pools that moved <5% in 24h, wide band: **+0.52% / +1.37%**, positive in both.
- DOGE/SOL (0.25% fee) over 8.3 days, 20 SOL: +1.83 SOL unhedged, +1.35 SOL hedged on Hyperliquid; positive every day.
- Scripts: `scripts/bt_hedged.mjs`, `scripts/bt_doge.mjs`. Settings: MAX_RANGE_24H=1.05, BINS 34/34, FLOOR 12%, ROTATE_OUT_SCANS=72.

## Oct 27 (later): chasing >0.5%/day
- Measured real per-bin liquidity: thin pools (PUMP, PEPE, wNEAR) would give a tight 20 SOL position 2–6%/day in fees *if
  price stayed in band*. Simulated hourly over 8 days they all lose (PUMP ±3 bins: +2.7 SOL fees, −8.4 SOL price, 167
  re-centres). Thin liquidity at the price = informed flow that runs LPs over.
- DOGE/SOL concentrated: +0.67–0.71%/day over the last 8 days, but −0.32% to −0.69%/day over 41.7 days (25–28 red days of 43).
  The good week was the best of six. Hedged on Hyperliquid: −0.6% to −1.6%/day (re-hedging a tight position in chop).
- Conclusion: no LP configuration tested clears 0.5%/day out of sample. Scripts: bt_conc.mjs, bt_doge41.mjs.

## Oct 27: cross-venue pool arbitrage (on-chain liq pool arb)
- Universe: 30 tokens trading vs SOL on 2+ venues with ≥$15k liquidity (DexScreener): PUMP, ZEC, HYPE, JUP, USELESS, STONK,
  ANSEM, ORE, CARDS, pump.fun coins with PumpSwap + Meteora pools, etc.
- Live executable round trips via Jupiter pinned per venue (buy on the cheapest, sell on each other venue), after fees and
  network cost: 0 of 84 profitable over two rounds (0.5 SOL: best −4.7 bps, median −42 bps; 0.1 SOL: best −9.8, median −50).
- Gaps close inside the block that creates them (searchers backrun via Jito with streamed state). Polling at seconds of latency
  sees only already-closed prices. Script: scripts/arb_scan.mjs <sizeSOL> <roundLabel>.
