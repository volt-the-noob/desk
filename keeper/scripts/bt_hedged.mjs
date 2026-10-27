// Delta-neutral LP backtest: earn Meteora DLMM fees, short the pool token on Hyperliquid for exactly the tokens the
// position holds (paired with a SOL long so the hedge is in SOL terms). Same walk-forward rules as bt_strategies:
// at each hour only past data is used. Two independent 48h windows. Costs: HL taker 0.045% per leg + 0.03% slippage,
// real hourly funding for both legs, entry/exit swap slippage, gas. 15% of capital sits on HL as margin (earns nothing).
import fs from 'node:fs';
const H = JSON.parse(fs.readFileSync('/tmp/hedge.json'));
const load = (f) => { const d = JSON.parse(fs.readFileSync(f)); d.pools = d.pools.filter((p) => H.map[p.addr]).map((p) => ({ ...p, hl: H.map[p.addr], bars: new Map(p.bars.map(([t, o, h, l, c, fee]) => [t, { o, h, l, c, fee }])) })); return d; };
const W = { A: load('/tmp/w0-met.json'), B: load('/tmp/w48-met.json') };
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const tokens = ({ L, pa, pb }, p) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / Math.sqrt(pb)); };
const inBand = (b, pa, pb) => { const lo = Math.max(b.l, pa), hi = Math.min(b.h, pb); return b.h > b.l ? Math.max(0, hi - lo) / (b.h - b.l) : (b.c >= pa && b.c <= pb ? 1 : 0); };
const WTS = [30, 22, 16, 12, 8, 6, 3, 3];
const seatShare = (r, n) => { const w = WTS.slice(0, n); const t = w.reduce((a, b) => a + b, 0); return Math.min(Math.max(0.3, 1 / n), w[r] / t); };

function sim(win, c) {
  const CAP = 20, HOURS = 48, end = win.end, pools = win.pools;
  const MARGIN = c.hedge ? 0.15 : 0, HEDGE_COST = 2 * 0.00045 + 0.0003;
  let free = CAP * (1 - MARGIN), fees = 0, lp = 0, hedgePnl = 0, hedgeCost = 0, funding = 0, gas = 0, recenters = 0;
  const open = new Map();
  const close = (s, p, slip) => { const v = posValue(s.pos, p); const tok = tokens(s.pos, p) * p; const out = v - tok * slip; lp += out - s.cost; free += out; gas += 0.0006; if (c.hedge) hedgeCost += s.h * p * HEDGE_COST; open.delete(s.p.addr); };
  for (let t = end - HOURS * 3600; t < end; t += 3600) {
    const h0 = Math.floor(t / 3600);
    for (const s of [...open.values()]) {
      const b = s.p.bars.get(t); if (!b) continue;
      const pPrev = s.last, p = b.c;
      // fees while in band
      const f = s.cap * (b.fee / s.p.tvl) * c.capture * inBand(b, s.pos.pa, s.pos.pb); fees += f; free += f;
      if (c.hedge) {
        hedgePnl += -s.h * (p - pPrev);                                              // short token vs SOL
        funding += s.h * p * ((H.fund[s.p.hl]?.[h0] ?? 0) - (H.fund.SOL?.[h0] ?? 0)); // short receives token funding, SOL long pays SOL funding
      }
      if (!c.hedge && c.floor && b.l <= s.entry * (1 - c.floor)) { close(s, s.entry * (1 - c.floor), 0.015); continue; }
      if (b.c < s.pos.pa || b.c > s.pos.pb) {                                         // re-center, inventory mode
        const v = posValue(s.pos, p), w = Math.pow(1 + s.p.binStep / 1e4, c.bins) - 1;
        lp += v - s.cost;
        s.pos = p > s.pos.pb ? posFromValue(v, p, p / (1 + w), p) : posFromValue(v, p, p, p * (1 + w));
        s.cost = v; recenters++; gas += 0.0006;
      }
      if (c.hedge) { const want = tokens(s.pos, p); const drift = Math.abs(want - s.h) * p; if (drift > c.rebal * s.cap) { hedgeCost += drift * HEDGE_COST; s.h = want; } }
      s.last = p;
    }
    // scan on past data only
    const scored = pools.filter((p) => p.bars.get(t) && (t - p.created) / 3600 >= 6).map((p) => {
      const h1 = p.bars.get(t - 3600)?.fee ?? 0; let d = 0; for (let k = 1; k <= 24; k++) d += p.bars.get(t - k * 3600)?.fee ?? 0;
      const r1 = (h1 / p.tvl) * 100; return { p, r1, score: 0.6 * r1 * 24 + 0.4 * (d / p.tvl) * 100 };
    }).filter((x) => x.r1 >= c.min1h).sort((a, b) => b.score - a.score);
    const capNow = free + [...open.values()].reduce((a, s) => a + s.cap, 0), n = Math.max(2, Math.min(8, Math.floor(capNow / 4)));
    const hot = new Set(scored.slice(0, n * 2).map((x) => x.p.addr));
    for (const s of [...open.values()]) { s.miss = hot.has(s.p.addr) ? 0 : s.miss + 1; if (s.miss >= c.rotate) close(s, s.p.bars.get(t).o, 0.008); }
    for (const x of scored) {
      if (open.size >= n) break; if (open.has(x.p.addr)) continue;
      const budget = Math.min(capNow * seatShare(open.size, n), free); if (budget < 1.5) break;
      const p0 = x.p.bars.get(t).o, w = Math.pow(1 + x.p.binStep / 1e4, c.bins) - 1, v = budget * (1 - 0.0025);
      const pos = posFromValue(v, p0, p0 / (1 + w), p0 * (1 + w));
      const s = { p: x.p, cap: budget, cost: v, entry: p0, last: p0, miss: 0, pos, h: c.hedge ? tokens(pos, p0) : 0 };
      if (c.hedge) hedgeCost += s.h * p0 * HEDGE_COST;
      open.set(x.p.addr, s); free -= budget; lp -= budget - v; gas += 0.0006;
    }
  }
  let mark = 0; for (const s of open.values()) { const last = [...s.p.bars.values()].at(-1).c; mark += posValue(s.pos, last) - s.cost; if (c.hedge) mark += 0; }
  const net = fees + lp + mark + hedgePnl + funding - hedgeCost - gas;
  return { ret: net / CAP * 100, net, fees, lp: lp + mark, hedgePnl, funding, hedgeCost, gas, recenters };
}
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`hedgeable pools: A ${W.A.pools.length} · B ${W.B.pools.length} (${[...new Set(W.A.pools.map((p) => p.sym))].join(', ')})\n`);
console.log('strategy'.padEnd(44) + 'cap  A: return   fees   lp/IL  hedge  fund  costs |  B: return   fees   lp/IL  hedge');
const rows = [];
for (const hedge of [false, true]) for (const bins of [20, 40, 69]) for (const rotate of [3, 8]) for (const capture of [1.0, 1.5]) {
  const c = { hedge, bins, rotate, capture, min1h: 0.1, floor: hedge ? 0 : 0.35, rebal: 0.05 };
  const a = sim(W.A, c), b = sim(W.B, c); rows.push({ c, a, b });
  const name = `${hedge ? 'HEDGED' : 'unhedged'} · bins ${bins} · rotate ${rotate}h`;
  console.log(`${name.padEnd(44)}${capture.toFixed(1)}  ${(f(a.ret, 1) + '%').padStart(8)} ${f(a.fees).padStart(6)} ${f(a.lp).padStart(7)} ${f(a.hedgePnl).padStart(6)} ${f(a.funding, 3).padStart(6)} ${f(-(a.hedgeCost + a.gas)).padStart(6)} | ${(f(b.ret, 1) + '%').padStart(8)} ${f(b.fees).padStart(6)} ${f(b.lp).padStart(7)} ${f(b.hedgePnl).padStart(6)}`);
}
fs.writeFileSync('/tmp/hedged-results.json', JSON.stringify(rows));
