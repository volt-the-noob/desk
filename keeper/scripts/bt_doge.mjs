// 8-day hourly simulation of one hedged LP seat in the DOGE/SOL DLMM pool (0.25% fee, LPs keep 90%).
// Capital 20 SOL: 85% in the pool, 15% on Hyperliquid as margin. Hedge = short DOGE + long SOL (same notional),
// rebalanced when it drifts by more than 5% of the seat. Real hourly funding for both legs; taker 0.045%/leg + 0.03% slippage.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync('/tmp/doge7d.json'));
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const tokens = ({ L, pa, pb }, p) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / Math.sqrt(pb)); };
const inBand = (b, pa, pb) => { const lo = Math.max(b[3], pa), hi = Math.min(b[2], pb); return b[2] > b[3] ? Math.max(0, hi - lo) / (b[2] - b[3]) : (b[4] >= pa && b[4] <= pb ? 1 : 0); };
function run({ hedge, bins, capture, rebal = 0.05 }) {
  const CAP = 20, M = hedge ? 0.15 : 0, seat = CAP * (1 - M), w = Math.pow(1.0025, bins) - 1, COST = 2 * 0.00045 + 0.0003;
  const bars = D.bars; let p0 = bars[0][1];
  let pos = posFromValue(seat * 0.9975, p0, p0 / (1 + w), p0 * (1 + w)), cost = seat * 0.9975, h = hedge ? tokens(pos, p0) : 0, last = p0;
  let fees = 0, lp = -(seat - cost), hp = 0, fund = 0, hc = hedge ? h * p0 * COST : 0, rec = 0;
  const daily = {};
  for (const b of bars) {
    const p = b[4], day = new Date(b[0] * 1000).toISOString().slice(5, 10);
    const f = seat * (b[5] / D.tvl) * capture * inBand(b, pos.pa, pos.pb); fees += f;
    if (hedge) { hp += -h * (p - last); fund += h * p * ((D.fund.DOGE[Math.floor(b[0] / 3600)] ?? 0) - (D.fund.SOL[Math.floor(b[0] / 3600)] ?? 0)); }
    if (p < pos.pa || p > pos.pb) { const v = posValue(pos, p); lp += v - cost; pos = p > pos.pb ? posFromValue(v, p, p / (1 + w), p) : posFromValue(v, p, p, p * (1 + w)); cost = v; rec++; }
    if (hedge) { const want = tokens(pos, p), drift = Math.abs(want - h) * p; if (drift > rebal * seat) { hc += drift * COST; h = want; } }
    last = p;
    const eq = fees + lp + (posValue(pos, p) - cost) + hp + fund - hc;
    daily[day] = eq;
  }
  const end = bars.at(-1)[4];
  const total = fees + lp + (posValue(pos, end) - cost) + hp + fund - hc - (hedge ? h * end * COST : 0);
  return { total, fees, il: lp + (posValue(pos, end) - cost), hp, fund, hc, rec, daily, days: bars.length / 24 };
}
const f = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`DOGE/SOL pool · ${(D.bars.length / 24).toFixed(1)} days · TVL $${Math.round(D.tvl).toLocaleString()} · DOGE moved ${f((D.bars.at(-1)[4] / D.bars[0][1] - 1) * 100, 2)}% vs SOL\n`);
console.log('setup                        net SOL   per day   fees    price/IL   hedge   funding  hedge cost  re-centers');
for (const hedge of [false, true]) for (const bins of [10, 20, 40]) for (const capture of [1.0, 1.5]) {
  const r = run({ hedge, bins, capture });
  console.log(`${(hedge ? 'HEDGED  ' : 'unhedged') + ` ±${(Math.pow(1.0025, bins) * 100 - 100).toFixed(1)}% band cap ${capture}`.padEnd(29)} ${f(r.total).padStart(7)}  ${f(r.total / r.days / 20 * 100, 2).padStart(6)}%  ${f(r.fees).padStart(6)}  ${f(r.il).padStart(8)}  ${f(r.hp).padStart(6)}  ${f(r.fund, 4).padStart(8)}  ${f(-r.hc).padStart(9)}  ${String(r.rec).padStart(6)}`);
}
const best = run({ hedge: true, bins: 20, capture: 1.0 });
console.log('\nhedged ±5.1% band, capture 1.0, equity gain by day (SOL):', Object.entries(best.daily).map(([d, v]) => `${d} ${f(v, 2)}`).join(' · '));
