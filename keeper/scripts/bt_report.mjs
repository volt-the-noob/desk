import { sim, W } from './bt_core.mjs';
import fs from 'node:fs';
const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
// 1. dedupe both-window winners by venue, show the best non-PumpSwap ones too
const both = JSON.parse(fs.readFileSync('/tmp/bt-both.json'));
const key = (c) => c.venues.join('+') + (c.venues.includes('pumpswap') && c.venues.length === 1 ? `|f${c.floor}|r${c.rotate}|h${c.maxHold}|m${c.maxRange}` : JSON.stringify(c));
const seen = new Set(); console.log('distinct winners in both windows:');
for (const g of both) { const k = key(g.c); if (seen.has(k)) continue; seen.add(k); const c = g.c;
  console.log(`  ${c.venues.join('+').padEnd(24)} A ${f(g.a.ret)}%  B ${f(g.b.ret)}%  feesA ${g.a.fees.toFixed(2)}  inventoryA ${f(g.a.band, 2)}  floor ${c.floor} rotate ${c.rotate} maxHold ${c.maxHold || '∞'} range<${c.maxRange || '∞'}${c.venues[0] === 'pumpswap' ? '' : ` bins ${c.bins} ${c.recenter ? 'recenter' : 'hold'} ${c.side}`}`); }
// 2. where did PumpSwap profit come from? per pool, both windows
console.log('\nPumpSwap pools (age ≥6h): fee yield vs price move over each window');
for (const [wn, win] of Object.entries(W)) {
  const d = win[2]; if (!d.end) continue;
  for (const p of d.pools) { const bars = [...p.bars.entries()].filter(([t]) => t >= d.end - 48 * 3600 && t < d.end).map(([, b]) => b); if (bars.length < 24) continue;
    const fee = bars.reduce((a, b) => a + b.fee, 0) / p.tvl * 100, mv = (bars.at(-1).c / bars[0].o - 1) * 100, lpPrice = (Math.sqrt(bars.at(-1).c / bars[0].o) - 1) * 100;
    console.log(`  ${wn} ${p.sym.padEnd(10)} LP fees ${fee.toFixed(1).padStart(5)}%  token ${f(mv, 0).padStart(5)}%  → LP price effect ${f(lpPrice, 1).padStart(6)}%`); }
}
// 3. fee-only view: what the PumpSwap strategy earned from fees alone, and what would have been paid out
const best = both.find((g) => g.c.venues.length === 1 && g.c.venues[0] === 'pumpswap').c;
for (const [wn, win] of Object.entries(W)) { const r = sim(win, best); console.log(`\nbest PumpSwap config, window ${wn}: return ${f(r.ret)}% · fees ${r.fees.toFixed(2)} SOL (${f(r.fees / 20 * 100)}%) · inventory ${f(r.band, 2)} SOL · paid out ${r.paid.toFixed(2)} SOL · entries ${r.trades}`); }
