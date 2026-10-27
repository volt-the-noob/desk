// 24h walk-forward test of the launch configuration. Hourly; at each hour only past data is used.
// Calm sleeve 3 SOL / meme sleeve 2 SOL, Meteora DLMM (wide band, re-centre) + PumpSwap (full range), live filters & exits.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync('/tmp/bt24.json')); const END = D.end, START = END - 24 * 3600, SOLUSD = 100;
const COOL = Number(process.argv[2] ?? 0);
const C = { calmCap: 3, memeCap: 2, minSeat: 1.0, bins: 34, floorCalm: .12, floorMeme: .12, trail: .10, maxHoldMeme: 6, calmOut: 6, memeOut: 1, calmBreaker: -.15, memeBreaker: -.40,
  calmRange: 1.05, calmTvl: 100000, calmAgeH: 168, calmVol: 300000, memeMcap: 5e5, memeVol: 5e5, memeLiq: 2e4, memeHolders: 1500, memeOrganic: 50, memeTop10: 35, memeDev: 10 };
const pools = D.pools.map((p) => ({ ...p, bars: new Map(p.bars.map(([t, o, h, l, c, fee, vol]) => [t, { o, h, l, c, fee, vol }])) }));
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const tokFrac = ({ L, pa, pb }, p) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); const v = posValue({ L, pa, pb }, p); return v ? L * (1 / sp - 1 / Math.sqrt(pb)) * p / v : 0; };
const inBand = (b, pa, pb) => { const lo = Math.max(b.l, pa), hi = Math.min(b.h, pb); return b.h > b.l ? Math.max(0, hi - lo) / (b.h - b.l) : (b.c >= pa && b.c <= pb ? 1 : 0); };
const W = [30, 22, 16]; const seatShare = (r, n) => { const w = W.slice(0, n), t = w.reduce((a, b) => a + b, 0); return Math.min(Math.max(.3, 1 / n), w[r] / t); };
const trailing = (p, t, n) => { let fee = 0, vol = 0, hi = 0, lo = Infinity; for (let k = 1; k <= n; k++) { const b = p.bars.get(t - k * 3600); if (b) { fee += b.fee; vol += b.vol; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); } } return { fee, vol, rng: lo < Infinity && lo > 0 ? hi / lo : 99 }; };
const coinOkMeme = (c) => c.mcap >= C.memeMcap && c.holders >= C.memeHolders && c.organic >= C.memeOrganic && c.mintOff && c.freezeOff && c.top10 <= C.memeTop10 && c.dev <= C.memeDev;
const fmtT = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

const open = new Map(), trades = [], log = [], cooldown = new Map(); let paused = { calm: 0, meme: 0 };
const realised = { calm: [], meme: [] };
const deployed = (sl) => [...open.values()].filter((s) => s.sl === sl).reduce((a, s) => a + s.cap, 0);
function value(s, p) { return s.venue === 'pumpswap' ? s.cost * Math.sqrt(p / s.ref) : posValue(s.pos, p); }
function close(s, t, p, reason) {
  const v = value(s, p), tokenPart = s.venue === 'pumpswap' ? .5 : tokFrac(s.pos, p), cost = v * tokenPart * (s.venue === 'pumpswap' ? .01 : .008) + .0012;
  const out = v - cost, price = out - s.cost - s.entryCost;
  const net = s.fees + price;
  realised[s.sl].push(net); open.delete(s.addr);
  if (COOL && /floor|trailing|BREAKER/.test(reason)) cooldown.set(s.p.mint, t + COOL * 3600);
  trades.push({ sl: s.sl, venue: s.venue, sym: s.sym, in: fmtT(s.t0), out: fmtT(t), held: Math.round((t - s.t0) / 3600), cap: s.cap, fees: s.fees, price, net, reason, recenters: s.rec });
}
for (let t = START; t < END; t += 3600) {
  // 1. tick open seats on this hour's bar
  for (const s of [...open.values()]) {
    const b = s.p.bars.get(t); if (!b) continue;
    const fl = s.entry * (1 - (s.sl === 'meme' ? C.floorMeme : C.floorCalm));
    if (b.l <= fl) { close(s, t, fl, 'floor 12%'); continue; }
    if (s.sl === 'meme') {
      if (b.l <= s.peak * (1 - C.trail)) { close(s, t, s.peak * (1 - C.trail), 'trailing stop 10%'); continue; }
      s.peak = Math.max(s.peak, b.c);
    }
    const share = s.venue === 'pumpswap' ? 1 : inBand(b, s.pos.pa, s.pos.pb);
    s.fees += s.cap * (b.fee / s.p.tvl) * share;
    if (s.venue === 'dlmm' && (b.c < s.pos.pa || b.c > s.pos.pb)) { const v = posValue(s.pos, b.c), w = Math.pow(1 + s.p.binStep / 1e4, C.bins) - 1; s.pos = b.c > s.pos.pb ? posFromValue(v, b.c, b.c / (1 + w), b.c) : posFromValue(v, b.c, b.c, b.c * (1 + w)); s.rec++; s.cost += 0; }
    if (s.sl === 'meme' && t - s.t0 >= C.maxHoldMeme * 3600) { close(s, t, b.c, 'max hold 6h'); continue; }
  }
  // 2. breakers (closed + open)
  for (const sl of ['calm', 'meme']) {
    if (t < paused[sl]) continue;
    let res = realised[sl].reduce((a, b) => a + b, 0);
    for (const s of open.values()) if (s.sl === sl) { const b = s.p.bars.get(t); if (b) res += s.fees + value(s, b.c) - s.cost - s.entryCost; }
    if (res < (sl === 'meme' ? C.memeBreaker : C.calmBreaker)) {
      for (const s of [...open.values()]) if (s.sl === sl) close(s, t, s.p.bars.get(t)?.c ?? s.entry, 'CIRCUIT BREAKER');
      paused[sl] = t + (sl === 'meme' ? 48 : 24) * 3600; realised[sl] = [];
      log.push(`${fmtT(t)}  ${sl} breaker tripped at ${res.toFixed(3)} SOL: seats closed, paused`);
    }
  }
  // 3. scan (past data only) per sleeve
  const scan = { calm: [], meme: [] };
  for (const p of pools) {
    const b = p.bars.get(t); if (!b) continue;
    const ageH = (t - p.created) / 3600, tr = trailing(p, t, 24), h1 = p.bars.get(t - 3600);
    const r24 = tr.fee / p.tvl * 100, r1 = (h1?.fee ?? 0) / p.tvl * 100;
    if (p.coin.verified && ageH >= C.calmAgeH && p.tvl >= C.calmTvl && tr.vol >= C.calmVol && tr.rng <= C.calmRange) scan.calm.push({ p, score: r24 / Math.max(.005, tr.rng - 1), r24, rng: tr.rng });
    if (coinOkMeme(p.coin) && p.tvl >= C.memeLiq && tr.vol >= C.memeVol && ageH >= 1) scan.meme.push({ p, score: .6 * r1 * 24 + .4 * r24, r24, rng: tr.rng });
  }
  for (const sl of ['calm', 'meme']) {
    const best = new Map(); for (const x of scan[sl]) { const o = best.get(x.p.mint); if (!o || x.score > o.score) best.set(x.p.mint, x); }
    const list = [...best.values()].sort((a, b) => b.score - a.score);
    const cap = sl === 'calm' ? C.calmCap : C.memeCap, seats = 2, good = new Set(list.slice(0, seats * 2).map((x) => x.p.addr));
    for (const s of [...open.values()]) if (s.sl === sl) { s.miss = good.has(s.addr) ? 0 : s.miss + 1; if (s.miss >= (sl === 'meme' ? C.memeOut : C.calmOut)) close(s, t, s.p.bars.get(t).o, sl === 'meme' ? 'left the filters' : 'cooled 6h'); }
    if (t < paused[sl]) continue;
    for (const x of list) {
      const mine = [...open.values()].filter((s) => s.sl === sl);
      if (mine.length >= seats) break;
      if ([...open.values()].some((s) => s.p.mint === x.p.mint)) continue;
      if ((cooldown.get(x.p.mint) ?? 0) > t) continue;
      const capital = Math.min(cap, cap), free = cap - deployed(sl), budget = Math.min(capital * seatShare(mine.length, seats), free);
      if (budget < C.minSeat) break;
      const p0 = x.p.bars.get(t).o, w = Math.pow(1 + (x.p.binStep || 50) / 1e4, C.bins) - 1, entryCost = budget * (x.p.venue === 'pumpswap' ? .005 : .0025) + .0012;
      open.set(x.p.addr, { sl, venue: x.p.venue, sym: x.p.sym, addr: x.p.addr, p: x.p, cap: budget, cost: budget, entryCost, ref: p0, entry: p0, peak: p0, t0: t, fees: 0, miss: 0, rec: 0,
        pos: x.p.venue === 'dlmm' ? posFromValue(budget, p0, p0 / (1 + w), p0 * (1 + w)) : null });
      log.push(`${fmtT(t)}  ${sl} ENTER ${x.p.sym} on ${x.p.venue === 'dlmm' ? 'Meteora' : 'PumpSwap'} with ${budget.toFixed(2)} SOL (fees/TVL 24h ${x.r24.toFixed(2)}%, 24h range ${((x.rng - 1) * 100).toFixed(1)}%${sl === 'meme' ? `, ${x.p.coin.holders} holders, organic ${Math.round(x.p.coin.organic)}` : ''})`);
    }
  }
}
for (const s of [...open.values()]) { const last = [...s.p.bars.keys()].filter((k) => k < END).sort().at(-1); close(s, END, s.p.bars.get(last).c, 'still open (marked)'); }
const f = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`${COOL ? `[re-entry cooldown ${COOL}h after a stop-out] ` : '[no cooldown] '}DESK · 24h test · ${fmtT(START)} → ${fmtT(END)} UTC · pool cap 5 SOL (calm 3 / meme 2) · ${pools.length} pools (${pools.filter((p) => p.venue === 'dlmm').length} Meteora, ${pools.filter((p) => p.venue === 'pumpswap').length} PumpSwap)\n`);
console.log('TIMELINE'); for (const l of log) console.log('  ' + l);
console.log('\nTRADES');
console.log('  sleeve venue     coin        in           out          held  capital   fees     price     net SOL   why closed');
for (const x of trades) console.log(`  ${x.sl.padEnd(6)} ${(x.venue === 'dlmm' ? 'Meteora' : 'PumpSwap').padEnd(9)} ${x.sym.slice(0, 10).padEnd(10)}  ${x.in}  ${x.out}  ${String(x.held).padStart(3)}h  ${x.cap.toFixed(2).padStart(6)}  ${f(x.fees).padStart(7)}  ${f(x.price).padStart(7)}  ${f(x.net).padStart(8)}   ${x.reason}${x.recenters ? ` · ${x.recenters} re-centres` : ''}`);
for (const sl of ['calm', 'meme']) { const t = trades.filter((x) => x.sl === sl); const net = t.reduce((a, x) => a + x.net, 0), fees = t.reduce((a, x) => a + x.fees, 0); console.log(`\n${sl.toUpperCase()} sleeve: ${t.length} trades · fees ${f(fees)} · price ${f(net - fees)} · net ${f(net)} SOL (${f(net / (sl === 'calm' ? 3 : 2) * 100, 2)}% of its cap) · winners ${t.filter((x) => x.net > 0).length}/${t.length}`); }
const all = trades.reduce((a, x) => a + x.net, 0);
console.log(`\nTOTAL pool desk: ${f(all)} SOL on 5 SOL (${f(all / 5 * 100, 2)}%) ≈ $${(all * SOLUSD).toFixed(2)}`);
fs.writeFileSync('/tmp/bt24-trades.json', JSON.stringify({ trades, log }));
