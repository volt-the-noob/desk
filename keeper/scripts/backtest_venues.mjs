// Walk-forward 48h comparison across venues and token sets, same capital rules as the live desk.
//   Meteora DLMM  : concentrated band (±BINS), inventory re-centering, fee = pool fee/TVL x capture while in band
//   PumpSwap      : full-range constant product, value ∝ sqrt(price), LP fee 0.20% of volume, always earning
// usage: node scripts/backtest_venues.mjs --capital 20 --hours 48
import fs from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const CAPITAL = Number(args.capital ?? 20), HOURS = Number(args.hours ?? 48);
const SOL = 'So11111111111111111111111111111111111111112';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u, tries = 5) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (r.ok) return r.json(); if (r.status === 429) await sleep(6000); } catch {} await sleep(1500 * (i + 1)); } throw new Error('fetch ' + u); };
const end = Math.floor(Date.now() / 3600e3) * 3600, start = end - (HOURS + 24) * 3600;
const CACHE = '/tmp/bt-venues.json';

async function loadMeteora() {
  const f = encodeURIComponent(`is_blacklisted=false && tvl>=50000 && volume_24h>=300000 && token_y=${SOL}`);
  const list = (await get(`https://dlmm.datapi.meteora.ag/pools?page_size=100&sort_by=volume_24h:desc&filter_by=${f}`)).data.filter((p) => p.token_x?.freeze_authority_disabled !== false);
  const out = [];
  for (const p of list) {
    const [o, v] = await Promise.all([get(`https://dlmm.datapi.meteora.ag/pools/${p.address}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`), get(`https://dlmm.datapi.meteora.ag/pools/${p.address}/volume/history?timeframe=1h&start_time=${start}&end_time=${end}`)]);
    const fees = new Map(v.data.map((x) => [x.timestamp, x.fees - (x.protocol_fees ?? 0)]));
    out.push({ venue: 'meteora', addr: p.address, mint: p.token_x.address, sym: p.token_x.symbol, launchpad: p.launchpad || '', tvl: Number(p.tvl), binStep: p.pool_config?.bin_step ?? 50,
      created: p.created_at > 1e12 ? p.created_at / 1000 : p.created_at, bars: o.data.map((x) => [x.timestamp, x.open, x.high, x.low, x.close, fees.get(x.timestamp) ?? 0]) });
  }
  return out;
}

async function loadPumpSwap() {
  const pools = [];
  for (let page = 1; page <= 5; page++) {
    const d = (await get(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?sort=h24_volume_usd_desc&page=${page}`)).data;
    for (const p of d) {
      const a = p.attributes;
      if (p.relationships.quote_token.data.id !== `solana_${SOL}`) continue;
      const tvl = Number(a.reserve_in_usd), vol = Number(a.volume_usd.h24);
      if (tvl < 50000 || vol < 300000 || vol / tvl > 200) continue; // drop dust pools and obvious wash
      pools.push({ addr: a.address, mint: p.relationships.base_token.data.id.replace('solana_', ''), sym: a.name.split(' / ')[0], tvl, created: Date.parse(a.pool_created_at) / 1000 });
    }
    await sleep(2200);
  }
  const out = [];
  for (const p of pools.slice(0, 30)) {
    const o = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.addr}/ohlcv/hour?aggregate=1&limit=${HOURS + 25}&currency=token`);
    await sleep(2200);
    const rows = (o.data.attributes.ohlcv_list || []).map(([t, op, h, l, c, vol]) => [t, op, h, l, c, 0, vol]);
    // currency=token gives price in SOL and volume in SOL-equivalent; convert to USD fee using pool TVL ratio later via USD volume call
    const u = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.addr}/ohlcv/hour?aggregate=1&limit=${HOURS + 25}&currency=usd`);
    await sleep(2200);
    const usdVol = new Map((u.data.attributes.ohlcv_list || []).map((r) => [r[0], r[5]]));
    out.push({ venue: 'pumpswap', ...p, launchpad: 'pump.fun', bars: rows.map((r) => [r[0], r[1], r[2], r[3], r[4], (usdVol.get(r[0]) ?? 0) * 0.002]).sort((a, b) => a[0] - b[0]) });
  }
  return out;
}

let data;
if (args.cache && fs.existsSync(CACHE)) data = JSON.parse(fs.readFileSync(CACHE));
else { data = { meteora: await loadMeteora(), pumpswap: await loadPumpSwap() }; fs.writeFileSync(CACHE, JSON.stringify(data)); }
const verified = new Set((await get('https://lite-api.jup.ag/tokens/v2/tag?query=verified')).map((t) => t.id));
const solUsd = (await get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd').catch(() => ({ solana: { usd: 0 } }))).solana.usd;
const prep = (p) => ({ ...p, bars: new Map(p.bars.map(([t, o, h, l, c, fee]) => [t, { o, h, l, c, fee }])) });

// ---------- engine ----------
const posFromValue = (V, p, pa, pb) => { const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb); return { L: V / ((1 / sp - 1 / sb) * p + (sp - sa)), pa, pb }; };
const posValue = ({ L, pa, pb }, p) => { const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb)); return L * (1 / sp - 1 / sb) * p + L * (sp - sa); };
const inBand = (b, pa, pb) => { const lo = Math.max(b.l, pa), hi = Math.min(b.h, pb); return b.h > b.l ? Math.max(0, hi - lo) / (b.h - b.l) : (b.c >= pa && b.c <= pb ? 1 : 0); };
const W = [30, 22, 16, 12, 8, 6, 3, 3];
const seatCount = (c) => Math.max(2, Math.min(8, Math.floor(c / 4)));
const seatShare = (r, n) => { const w = W.slice(0, n); const t = w.reduce((a, b) => a + b, 0); return Math.min(Math.max(0.3, 1 / n), w[r] / t); };

function simulate(universe, o) {
  const pools = universe.map(prep);
  const CAPTURE = o.capture ?? 1, BINS = o.bins ?? 20, FLOOR = 0.35, ROT = o.rotate ?? 3, GAS = 0.0006, ENTRY = 0.005, EXIT = 0.015, MIN1H = o.min1h ?? 0.3;
  let free = CAPITAL, fees = 0, band = 0, costs = 0, pot = 0, holders = 0, ops = 0, recenters = 0;
  const open = new Map(), touched = new Map();
  const value = (s, p) => (s.cpmm ? s.cost * Math.sqrt(p / s.ref) : posValue(s.pos, p));
  const close = (s, p, slip) => { const v = value(s, p) * (1 - slip); const pnl = v - s.cost; band += pnl; pot += pnl; free += v; costs += GAS; pot -= GAS; open.delete(s.p.addr); touched.get(s.p.addr).net += pnl; };
  for (let t = end - HOURS * 3600; t < end; t += 3600) {
    for (const s of [...open.values()]) {
      const b = s.p.bars.get(t); if (!b) continue;
      if (b.l <= s.entry * (1 - FLOOR)) { close(s, s.entry * (1 - FLOOR), EXIT); continue; }
      const frac = s.cpmm ? 1 : inBand(b, s.pos.pa, s.pos.pb);
      const tvl = s.p.tvl;
      const f = s.cap * (b.fee / tvl) * (s.cpmm ? 1 : CAPTURE) * frac;
      fees += f; pot += f; free += f; touched.get(s.p.addr).net += f;
      if (!s.cpmm && (b.c < s.pos.pa || b.c > s.pos.pb)) {
        const v = posValue(s.pos, b.c), w = Math.pow(1 + s.p.binStep / 1e4, BINS) - 1, pnl = v - s.cost;
        band += pnl; pot += pnl; touched.get(s.p.addr).net += pnl;
        s.pos = b.c > s.pos.pb ? posFromValue(v, b.c, b.c / (1 + w), b.c) : posFromValue(v, b.c, b.c, b.c * (1 + w));
        s.cost = v; recenters++; costs += GAS; pot -= GAS; free -= GAS;
      }
    }
    const scored = pools.filter((p) => (t - p.created) / 3600 >= 6 && p.bars.get(t)).map((p) => {
      const h1 = p.bars.get(t - 3600)?.fee ?? 0; let d = 0; for (let k = 1; k <= 24; k++) d += p.bars.get(t - k * 3600)?.fee ?? 0;
      const r1 = (h1 / p.tvl) * 100; return { p, r1, score: 0.6 * r1 * 24 + 0.4 * (d / p.tvl) * 100 };
    }).filter((x) => x.r1 >= MIN1H).sort((a, b) => b.score - a.score);
    const cap = free + [...open.values()].reduce((a, s) => a + s.cap, 0), n = seatCount(cap);
    const hot = new Set(scored.slice(0, n * 2).map((x) => x.p.addr));
    for (const s of [...open.values()]) { s.miss = hot.has(s.p.addr) ? 0 : s.miss + 1; if (s.miss >= ROT) close(s, s.p.bars.get(t)?.o ?? s.entry, EXIT); }
    for (const x of scored) {
      if (open.size >= n) break; if (open.has(x.p.addr)) continue;
      const budget = Math.min(cap * seatShare(open.size, n), free); if (budget < 1.5) break;
      const p0 = x.p.bars.get(t).o, v = budget * (1 - ENTRY / 2), cpmm = x.p.venue === 'pumpswap';
      const w = Math.pow(1 + x.p.binStep / 1e4, BINS) - 1;
      open.set(x.p.addr, { p: x.p, cap: budget, cost: v, entry: p0, ref: p0, miss: 0, cpmm, pos: cpmm ? null : posFromValue(v, p0, p0 / (1 + w), p0 * (1 + w)) });
      free -= budget; band -= budget - v; pot -= budget - v; costs += GAS; pot -= GAS;
      if (!touched.has(x.p.addr)) touched.set(x.p.addr, { sym: x.p.sym, net: 0 }); touched.get(x.p.addr).net -= 0;
    }
    if ((t - (end - HOURS * 3600) + 3600) % 86400 === 0) { const out = Math.max(pot, 0); holders += out * 0.5; ops += out * 0.2; free -= out * 0.7; pot = Math.min(pot, 0); }
  }
  let unreal = 0, equity = free;
  for (const s of open.values()) { const last = [...s.p.bars.values()].at(-1).c; const v = value(s, last); unreal += v - s.cost; equity += v; }
  return { fees, band, costs, net: fees + band - costs, unreal, equity, holders, ops, recenters, seats: [...touched.values()].sort((a, b) => b.net - a.net) };
}

// ---------- scenarios ----------
const M = data.meteora, P = data.pumpswap;
const isPump = (p) => p.launchpad === 'pump.fun' || p.mint.endsWith('pump');
const sets = [
  ['Meteora DLMM · all tokens', M, {}],
  ['Meteora DLMM · all, wide band', M, { bins: 60 }],
  ['Meteora DLMM · pump.fun-launched only', M.filter(isPump), {}],
  ['Meteora DLMM · Meteora-launched (DBC) only', M.filter((p) => p.launchpad === 'met-dbc'), {}],
  ['Meteora DLMM · Jupiter-verified only', M.filter((p) => verified.has(p.mint)), {}],
  ['PumpSwap · full range', P, { min1h: 0.02 }],
  ['PumpSwap · Jupiter-verified only', P.filter((p) => verified.has(p.mint)), { min1h: 0.02 }],
  ['PumpSwap + Meteora combined', [...M, ...P], { min1h: 0.02 }],
];
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`\n${HOURS}h walk-forward · ${CAPITAL} SOL · SOL $${solUsd} · pools: Meteora ${M.length}, PumpSwap ${P.length}, verified in sets: M ${M.filter((p) => verified.has(p.mint)).length} / P ${P.filter((p) => verified.has(p.mint)).length}\n`);
console.log('scenario'.padEnd(46) + 'pools   fees    band  realised  open   equity  vs start');
const results = {};
for (const [name, u, o] of sets) {
  if (!u.length) { console.log(name.padEnd(46) + '  0  (no pools in window)'); continue; }
  for (const cap of [1.0, 1.5]) {
    const r = simulate(u, { ...o, capture: cap });
    if (cap === 1.0) results[name] = r;
    console.log(`${(name + (u[0].venue === 'meteora' || name.includes('combined') ? ` ·cap ${cap}` : '')).padEnd(46)}${String(u.length).padStart(5)} ${f(r.fees).padStart(7)} ${f(r.band).padStart(7)} ${f(r.net).padStart(9)} ${f(r.unreal).padStart(6)} ${r.equity.toFixed(2).padStart(7)} ${f((r.equity + r.holders + r.ops) / CAPITAL * 100 - 100, 1).padStart(7)}%`);
    if (name.startsWith('PumpSwap')) break;
  }
}
console.log('\nbest seats, PumpSwap:', results['PumpSwap · full range']?.seats.slice(0, 5).map((s) => `${s.sym} ${f(s.net)}`).join(', '));
console.log('worst seats, PumpSwap:', results['PumpSwap · full range']?.seats.slice(-3).map((s) => `${s.sym} ${f(s.net)}`).join(', '));
