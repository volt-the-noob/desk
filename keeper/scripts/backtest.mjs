// Rough 24h backtest of the desk's strategy on today's scanner picks.
// usage: node scripts/backtest.mjs --capital 20 [--capture 1.5] [--flat4]
// Honest limits: selection uses TODAY's 24h stats (lookahead), band P&L uses the 24h endpoint move
// (no intraday path), fees = capital × pool fee/TVL × capture factor. Treat it as an order-of-magnitude check.
process.env.SUPABASE_URL ??= 'memory'; process.env.WALLET_SECRET ??= 'x';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const CAPITAL = Number(args.capital ?? 20);
const CAPTURE = Number(args.capture ?? 1.5);       // band fee capture vs pool-average fee/TVL (concentration × time-in-range)
const BAND = Number(args.band ?? 0.105);           // ±10.5% band (20 bins each side at bin step 50)
const FLOOR = Number(args.floor ?? 0.35);
const SLIP = 0.02;

const { cfg, seatCount, seatShare } = await import('../src/config.js');
const { scanPools } = await import('../src/scanner.js');

const cands = await scanPools();
const flat4 = !!args.flat4;
const seats = flat4 ? 4 : seatCount(CAPITAL);
const picks = cands.slice(0, seats);

async function priceChange(mint) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  const j = await r.json();
  const pairs = (j.pairs || []).filter((p) => p.chainId === 'solana').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = pairs[0];
  return p ? { h24: Number(p.priceChange?.h24 ?? 0) / 100, h6: Number(p.priceChange?.h6 ?? 0) / 100, h1: Number(p.priceChange?.h1 ?? 0) / 100 } : null;
}

/**
 * Band P&L on a seat as a fraction of its capital, from the 24h endpoint move Δ.
 * Entry 50/50. Inside the band: half-exposed. Price leaves band up: token half sold into SOL, gain capped at BAND/2,
 * re-center puts SOL-only bids below → no further upside. Price leaves band down: SOL leg bought into token,
 * re-center re-lists tokens → fully exposed to the rest of the drop until the floor, then sold with slippage.
 */
function bandPnl(d) {
  if (d >= 0) return Math.min(d, BAND) / 2;
  const drop = Math.min(-d, FLOOR);
  const inBand = Math.min(drop, BAND) / 2;
  const beyond = Math.max(0, drop - BAND);
  return -(inBand + beyond) - (-d >= FLOOR ? SLIP : 0);
}

let totFees = 0, totBand = 0, totCap = 0;
const rows = [];
for (let i = 0; i < picks.length; i++) {
  const c = picks[i];
  const cap = flat4 ? CAPITAL / 4 : CAPITAL * seatShare(i, seats);
  const pc = await priceChange(c.tokenX);
  const d = pc?.h24 ?? 0;
  // if the pool floor-stopped, fees stop too: scale fees by the fraction of the day before the floor (crude: assume linear path)
  const alive = -d >= FLOOR ? FLOOR / -d : 1;
  const fees = cap * (c.ratio24h / 100) * CAPTURE * alive;
  const band = cap * bandPnl(d);
  totFees += fees; totBand += band; totCap += cap;
  rows.push({ seat: i + 1, pool: c.symbol, cap, feeTvl: c.ratio24h, d, fees, band, net: fees + band, floored: -d >= FLOOR });
}
const pot = totFees + totBand;
const f = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`\nDESK 24h backtest · ${CAPITAL} SOL · ${seats} seats${flat4 ? ' (flat 4×25%)' : ' (capital-scaled, rank-weighted)'} · capture ×${CAPTURE} · band ±${(BAND*100).toFixed(1)}% · floor −${FLOOR*100}%\n`);
console.log('seat pool          cap SOL  fee/tvl24  Δ24h     fees     band      net');
for (const r of rows) console.log(`${String(r.seat).padStart(3)}  ${r.pool.padEnd(12)} ${r.cap.toFixed(2).padStart(7)}  ${(r.feeTvl.toFixed(1)+'%').padStart(8)}  ${((r.d*100).toFixed(0)+'%').padStart(5)}  ${f(r.fees).padStart(7)}  ${f(r.band).padStart(7)}  ${f(r.net).padStart(7)}${r.floored ? '  FLOOR' : ''}`);
console.log(`\ndeployed ${totCap.toFixed(2)} of ${CAPITAL} SOL · fees ${f(totFees)} · band ${f(totBand)} · pot ${f(pot)} SOL (${f(pot / CAPITAL * 100, 1)}% of capital)`);
if (pot > 0) console.log(`split → holders ${(pot*0.5).toFixed(3)} · reserve ${(pot*0.3).toFixed(3)} · OPS ${(pot*0.2).toFixed(3)} SOL`);
else console.log('negative pot → no payout, loss carries to tomorrow');
console.log(`\nsensitivity: capture ×1.0 → pot ${f(totFees/CAPTURE*1.0 + totBand)} · ×2.5 → pot ${f(totFees/CAPTURE*2.5 + totBand)}`);
