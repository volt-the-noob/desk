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
