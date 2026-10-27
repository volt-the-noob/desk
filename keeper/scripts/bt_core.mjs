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


export { sim, W };
