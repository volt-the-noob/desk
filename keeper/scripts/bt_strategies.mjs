// Strategy search on two independent 48h windows (A = last 48h, B = the 48h before). Only strategies that profit in both count.
import fs from 'node:fs';
const load = (f) => { try { const d = JSON.parse(fs.readFileSync(f)); d.pools = d.pools.map((p) => ({ ...p, bars: new Map(p.bars.map(([t, o, h, l, c, fee]) => [t, { o, h, l, c, fee }])) })); return d; } catch { return { pools: [] }; } };
const W = { A: ['/tmp/w0-met.json', '/tmp/w0-maj.json', '/tmp/w0-ps.json'].map(load), B: ['/tmp/w48-met.json', '/tmp/w48-maj.json', '/tmp/w48-ps.json'].map(load) };
const CAPITAL = 20;
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const inBand = (b, pa, pb) => { const lo = Math.max(b.l, pa), hi = Math.min(b.h, pb); return b.h > b.l ? Math.max(0, hi - lo) / (b.h - b.l) : (b.c >= pa && b.c <= pb ? 1 : 0); };
const WTS = [30, 22, 16, 12, 8, 6, 3, 3];
const seatShare = (r, n) => { const w = WTS.slice(0, n); const t = w.reduce((a, b) => a + b, 0); return Math.min(Math.max(0.3, 1 / n), w[r] / t); };

function sim(win, c) {
  const end = win.find((d) => d.end)?.end; if (!end) return null;
  const pools = win.flatMap((d) => d.pools).filter((p) => c.venues.includes(p.venue));
  const HOURS = 48, GAS = 0.0006, ENTRY = c.venueCost ?? 0.005, EXIT = 0.015;
  let free = CAPITAL, fees = 0, band = 0, pot = 0, paid = 0, trades = 0;
  const open = new Map();
  const value = (s, p) => (s.cpmm ? s.cost * Math.sqrt(p / s.ref) : posValue(s.pos, p));
  const close = (s, p, slip) => { const v = value(s, p) * (1 - slip); band += v - s.cost; pot += v - s.cost - GAS; free += v; open.delete(s.p.addr); };
  const stats = (p, t) => { // trailing data only
    let d = 0, hi = 0, lo = Infinity; for (let k = 1; k <= 24; k++) { const b = p.bars.get(t - k * 3600); if (b) { d += b.fee; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); } }
    const h1 = p.bars.get(t - 3600), h6 = p.bars.get(t - 6 * 3600);
    return { r1: ((h1?.fee ?? 0) / p.tvl) * 100, r24: (d / p.tvl) * 100, rng: lo < Infinity && lo > 0 ? hi / lo : 99, ch6: h1 && h6 ? h1.c / h6.o - 1 : 0 };
  };
  for (let t = end - HOURS * 3600; t < end; t += 3600) {
    for (const s of [...open.values()]) {
      const b = s.p.bars.get(t); if (!b) continue;
      if (c.floor && b.l <= s.entry * (1 - c.floor)) { close(s, s.entry * (1 - c.floor), EXIT); continue; }
      if (c.takeProfit && b.h >= s.entry * (1 + c.takeProfit)) { close(s, s.entry * (1 + c.takeProfit), EXIT / 2); continue; }
      if (c.maxHold && t - s.t0 >= c.maxHold * 3600) { close(s, b.o, s.cpmm ? 0.003 : EXIT / 2); continue; }
      const frac = s.cpmm ? 1 : inBand(b, s.pos.pa, s.pos.pb);
      const f = s.cap * (b.fee / s.p.tvl) * (s.cpmm ? 1 : c.capture) * frac;
      fees += f; pot += f; free += f;
      if (!s.cpmm && c.recenter && (b.c < s.pos.pa || b.c > s.pos.pb)) {
        const v = posValue(s.pos, b.c), w = Math.pow(1 + s.p.binStep / 1e4, c.bins) - 1;
        band += v - s.cost; pot += v - s.cost - GAS; free -= GAS;
        s.pos = b.c > s.pos.pb ? posFromValue(v, b.c, b.c / (1 + w), b.c) : posFromValue(v, b.c, b.c, b.c * (1 + w));
        s.cost = v;
      }
    }
    const cand = pools.filter((p) => p.bars.get(t) && (t - p.created) / 3600 >= (c.minAge ?? 6)).map((p) => ({ p, ...stats(p, t) }))
      .filter((x) => x.r1 >= (x.p.venue === 'meteora' ? c.min1h : c.min1h / 10))
      .filter((x) => !c.maxRange || x.rng <= c.maxRange)
      .filter((x) => !c.trendUp || x.ch6 > 0)
      .filter((x) => !c.spike || x.r1 * 24 >= c.spike * x.r24)
      .map((x) => ({ ...x, score: 0.6 * x.r1 * 24 + 0.4 * x.r24 })).sort((a, b) => b.score - a.score);
    const cap = free + [...open.values()].reduce((a, s) => a + s.cap, 0);
    const n = Math.max(2, Math.min(c.maxSeats ?? 8, Math.floor(cap / 4)));
    const hot = new Set(cand.slice(0, n * 2).map((x) => x.p.addr));
    for (const s of [...open.values()]) { s.miss = hot.has(s.p.addr) ? 0 : s.miss + 1; if (s.miss >= c.rotate) close(s, s.p.bars.get(t)?.o ?? s.entry, s.cpmm ? 0.003 : EXIT); }
    for (const x of cand) {
      if (open.size >= n) break; if (open.has(x.p.addr)) continue;
      const budget = Math.min(cap * seatShare(open.size, n), free); if (budget < 1.5) break;
      const p0 = x.p.bars.get(t).o, cpmm = x.p.venue === 'pumpswap', v = budget * (1 - (cpmm ? 0.003 : ENTRY / 2));
      const w = Math.pow(1 + x.p.binStep / 1e4, c.bins) - 1;
      const pos = cpmm ? null : c.side === 'bid' ? posFromValue(v, p0, p0 / (1 + w) ** 2, p0) : posFromValue(v, p0, p0 / (1 + w), p0 * (1 + w));
      open.set(x.p.addr, { p: x.p, cap: budget, cost: v, entry: p0, ref: p0, miss: 0, cpmm, pos, t0: t });
      free -= budget; band -= budget - v; pot -= budget - v + GAS; trades++;
    }
    if ((t - (end - HOURS * 3600) + 3600) % 86400 === 0) { const out = Math.max(pot, 0); paid += out * 0.7; free -= out * 0.7; pot = Math.min(pot, 0); }
  }
  let eq = free; for (const s of open.values()) eq += value(s, [...s.p.bars.values()].at(-1).c);
  return { ret: ((eq + paid) / CAPITAL - 1) * 100, eq, fees, band, paid, trades };
}

// ---------- strategy families ----------
const base = { venues: ['meteora'], bins: 20, recenter: true, side: 'both', floor: 0.35, rotate: 3, capture: 1.0, min1h: 0.3 };
const fam = {
  'S1 live config (hot memes, ±band, re-center)': base,
  'S2 wide band, set & forget (no re-center)': { ...base, bins: 34, recenter: false },
  'S3 calm pools only (24h range < 1.5x)': { ...base, bins: 34, maxRange: 1.5 },
  'S4 bid ladder: SOL-only bids below price': { ...base, side: 'bid', bins: 34, recenter: false },
  'S5 uptrend filter + calm': { ...base, bins: 34, trendUp: true, maxRange: 2 },
  'S6 fee-spike scalps, max 3h hold': { ...base, bins: 34, spike: 2, maxHold: 3, recenter: false },
  'S7 majors: SOL/USDC + LST/SOL': { ...base, venues: ['major'], min1h: 0.002, bins: 20, floor: 0 },
  'S8 PumpSwap full range': { ...base, venues: ['pumpswap'], min1h: 0.3, rotate: 6 },
  'S9 PumpSwap calm + tight floor': { ...base, venues: ['pumpswap'], min1h: 0.3, maxRange: 1.6, floor: 0.15, rotate: 6 },
  'S10 take-profit +15%, floor -12%': { ...base, bins: 34, recenter: false, takeProfit: 0.15, floor: 0.12 },
  'S11 everything, calm filter, 4 seats': { ...base, venues: ['meteora', 'pumpswap', 'major'], min1h: 0.05, maxRange: 1.5, bins: 34, maxSeats: 4 },
};
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);
console.log('\nstrategy'.padEnd(48) + '   A last 48h   B prior 48h   both?   fees(A)  paid(A)');
const rows = [];
for (const [name, c] of Object.entries(fam)) {
  const a = sim(W.A, c), b = sim(W.B, c);
  if (!a) continue;
  rows.push({ name, a, b, c });
  console.log(`${name.padEnd(47)} ${(f(a.ret) + '%').padStart(9)}   ${b ? (f(b.ret) + '%').padStart(9) : '     n/a '}    ${b && a.ret > 0 && b.ret > 0 ? ' YES' : '  no'}   ${a.fees.toFixed(2).padStart(6)}  ${a.paid.toFixed(2).padStart(6)}`);
}
// ---------- grid search: tune on A, check on B ----------
const grid = [];
for (const venues of [['meteora'], ['pumpswap'], ['major'], ['meteora', 'pumpswap'], ['meteora', 'pumpswap', 'major']])
for (const bins of [10, 20, 34]) for (const recenter of [true, false]) for (const side of ['both', 'bid'])
for (const maxRange of [0, 1.3, 1.6, 2.2]) for (const floor of [0, 0.12, 0.35]) for (const rotate of [1, 3, 8]) for (const maxHold of [0, 3, 12]) {
  const c = { ...base, venues, bins, recenter, side, maxRange, floor, rotate, maxHold, min1h: venues.includes('meteora') ? 0.3 : venues[0] === 'major' ? 0.002 : 0.3 };
  const a = sim(W.A, c); if (!a) continue; grid.push({ c, a });
}
grid.sort((x, y) => y.a.ret - x.a.ret);
console.log(`\ngrid: ${grid.length} combinations tuned on window A. Profitable on A: ${grid.filter((g) => g.a.ret > 0).length}`);
const top = grid.slice(0, 12).map((g) => ({ ...g, b: sim(W.B, g.c) }));
console.log('top 12 on A, then tested on B:');
const desc = (c) => `${c.venues.join('+')} bins${c.bins} ${c.recenter ? 'recenter' : 'hold'} ${c.side} range<${c.maxRange || '∞'} floor${c.floor} rot${c.rotate} hold${c.maxHold || '∞'}h`;
for (const g of top) console.log(`  A ${(f(g.a.ret) + '%').padStart(7)}  B ${g.b ? (f(g.b.ret) + '%').padStart(7) : '  n/a '}  ${desc(g.c)}`);
const both = grid.map((g) => ({ ...g, b: sim(W.B, g.c) })).filter((g) => g.b && g.a.ret > 0 && g.b.ret > 0).sort((x, y) => Math.min(y.a.ret, y.b.ret) - Math.min(x.a.ret, x.b.ret));
console.log(`\nprofitable in BOTH windows: ${both.length} of ${grid.length}`);
for (const g of both.slice(0, 10)) console.log(`  A ${(f(g.a.ret) + '%').padStart(7)}  B ${(f(g.b.ret) + '%').padStart(7)}  fees A ${g.a.fees.toFixed(2)}  paid A ${g.a.paid.toFixed(2)}  trades ${g.a.trades}  ${desc(g.c)}`);
fs.writeFileSync('/tmp/bt-both.json', JSON.stringify(both.slice(0, 30).map((g) => ({ c: g.c, a: g.a, b: g.b }))));
