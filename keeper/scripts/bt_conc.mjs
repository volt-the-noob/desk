// Concentrated calm-pool LP, 8 days hourly. Fee share = our liquidity per bin ÷ (ours + the pool's real liquidity at the
// price), applied only for the part of each hour price spent inside our band. Re-centre on exit (inventory mode, loss
// realised). Optional Hyperliquid hedge (short token vs SOL). 20 SOL total, split evenly across the pools in a portfolio.
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('/tmp/conc8.json')); const SOLUSD = 100;
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const tokens = ({ L, pa, pb }, p) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / Math.sqrt(pb)); };
const inBand = (b, pa, pb) => { const lo = Math.max(b[3], pa), hi = Math.min(b[2], pb); return b[2] > b[3] ? Math.max(0, hi - lo) / (b[2] - b[3]) : (b[4] >= pa && b[4] <= pb ? 1 : 0); };
function seat(pool, cap, k, hedge) {
  const w = Math.pow(1 + pool.binStep / 1e4, k) - 1, Lnear = pool.near.reduce((a, b) => a + b, 0) / 3, COST = 2 * 0.00045 + 0.0003;
  const bars = pool.bars; let p = bars[0][1];
  const margin = hedge ? cap * 0.15 : 0, V0 = (cap - margin) * 0.9975;
  let pos = posFromValue(V0, p, p / (1 + w), p * (1 + w)), cost = V0, h = hedge ? tokens(pos, p) : 0, last = p;
  let fees = 0, il = -(cap - margin - V0), hp = 0, hc = hedge ? h * p * COST : 0, rec = 0; const daily = new Map();
  for (const b of bars) {
    p = b[4];
    const ours = posValue(pos, p) / (2 * k + 1), share = ours / (ours + Lnear);
    const f = (b[5] / SOLUSD) * share * inBand(b, pos.pa, pos.pb); fees += f;
    if (hedge) hp += -h * (p - last);
    if (p < pos.pa || p > pos.pb) { const v = posValue(pos, p); il += v - cost; pos = p > pos.pb ? posFromValue(v, p, p / (1 + w), p) : posFromValue(v, p, p, p * (1 + w)); cost = v; rec++; il -= 0.0006; }
    if (hedge) { const want = tokens(pos, p), drift = Math.abs(want - h) * p; if (drift > 0.05 * cap) { hc += drift * COST; h = want; } }
    last = p;
    const day = new Date(b[0] * 1000).toISOString().slice(5, 10);
    daily.set(day, fees + il + (posValue(pos, p) - cost) + hp - hc);
  }
  return { net: fees + il + (posValue(pos, p) - cost) + hp - hc - (hedge ? h * p * COST : 0), fees, il: il + posValue(pos, p) - cost, hp, hc, rec, daily, days: bars.length / 24 };
}
function portfolio(syms, k, hedge) {
  const ps = P.filter((x) => syms.includes(x.sym)), cap = 20 / ps.length;
  const rs = ps.map((p) => seat(p, cap, k, hedge));
  const days = Math.min(...rs.map((r) => r.days)), net = rs.reduce((a, r) => a + r.net, 0);
  const all = [...rs[0].daily.keys()], cum = all.map((d) => rs.reduce((a, r) => a + (r.daily.get(d) ?? 0), 0));
  const dd = cum.map((v, i) => v - (i ? cum[i - 1] : 0));
  return { net, perDay: net / days / 20 * 100, fees: rs.reduce((a, r) => a + r.fees, 0), il: rs.reduce((a, r) => a + r.il, 0), hp: rs.reduce((a, r) => a + r.hp, 0), rec: rs.reduce((a, r) => a + r.rec, 0), worst: Math.min(...dd.slice(1)) / 20 * 100, best: Math.max(...dd.slice(1)) / 20 * 100, red: dd.slice(1).filter((x) => x < 0).length, nd: dd.length - 1 };
}
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
for (const p of P) console.log(`${p.sym.padEnd(6)} 8d move ${f((p.bars.at(-1)[4] / p.bars[0][1] - 1) * 100, 1)}% · LP fees ${(p.bars.reduce((a, b) => a + b[5], 0) / SOLUSD / 8.3).toFixed(2)} SOL/day · liquidity at price ${(p.near.reduce((a, b) => a + b, 0) / 3).toFixed(1)} SOL`);
console.log('\nportfolio (20 SOL)              band   hedge   net SOL  %/day   fees    price/IL  hedge   re-centres  worst day  red days');
const runs = [];
for (const syms of [['PUMP'], ['PEPE'], ['wNEAR'], ['DOGE'], ['PUMP', 'PEPE'], ['PUMP', 'PEPE', 'wNEAR'], ['PUMP', 'PEPE', 'wNEAR', 'DOGE']])
  for (const k of [3, 5, 10, 20]) for (const hedge of [false, true]) {
    if (hedge && !syms.every((s) => ['PUMP', 'DOGE', 'wNEAR'].includes(s))) continue;
    const r = portfolio(syms, k, hedge); runs.push({ syms, k, hedge, ...r });
    console.log(`${syms.join('+').padEnd(31)} ±${String(k).padStart(2)}bins ${hedge ? 'HEDGED' : '      '} ${f(r.net).padStart(7)}  ${f(r.perDay).padStart(6)}  ${f(r.fees).padStart(6)}  ${f(r.il).padStart(8)}  ${f(r.hp).padStart(6)}  ${String(r.rec).padStart(6)}     ${f(r.worst).padStart(6)}%    ${r.red}/${r.nd}`);
  }
fs.writeFileSync('/tmp/conc-results.json', JSON.stringify(runs));
