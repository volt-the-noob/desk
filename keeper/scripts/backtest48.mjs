// Walk-forward backtest over the last N hours on real hourly Meteora data.
// At each hour the desk only sees data up to that hour: it scores pools, rotates seats,
// re-centers bands on the real close, floor-stops on the real low, and earns fees only
// for the part of the hour price spent inside its band.
// usage: node scripts/backtest48.mjs --capital 20 --hours 48 [--capture 1.5]
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const CAPITAL = Number(args.capital ?? 20), HOURS = Number(args.hours ?? 48), CAPTURE = Number(args.capture ?? 1.5);
const BINS = Number(args.bins ?? 20), FLOOR = Number(args.floor ?? 0.35), SEAT_SOL = 4, MIN_SEATS = 2, MAX_SEATS = 8, MIN_SEAT = 1.5, MAX_SEAT_PCT = 0.30;
const W = [30, 22, 16, 12, 8, 6, 3, 3], MIN_1H = Number(args.min1h ?? 0.3), ROTATE_OUT = Number(args.rotate ?? 1), MAX_RANGE = Number(args.maxrange ?? 0); // hourly scans: 1 miss ≈ the live 15-min cool-off
const GAS = 0.0006, ENTRY_SLIP = 0.005, EXIT_SLIP = 0.015, SPLIT = { holders: 0.5, reserve: 0.3, ops: 0.2 };
const API = 'https://dlmm.datapi.meteora.ag', SOL = 'So11111111111111111111111111111111111111112';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { for (let i = 0; i < 4; i++) { const r = await fetch(u); if (r.ok) return r.json(); await sleep(800 * (i + 1)); } throw new Error('fetch ' + u); };

const end = Math.floor(Date.now() / 3600e3) * 3600, start = end - (HOURS + 24) * 3600; // +24h warm-up for trailing 24h scores
const filter = encodeURIComponent(`is_blacklisted=false && tvl>=50000 && volume_24h>=300000 && token_y=${SOL}`);
const universe = args.cache && fs.existsSync('/tmp/bt48-cache.json') ? [] : (await get(`${API}/pools?page_size=50&sort_by=volume_24h:desc&filter_by=${filter}`)).data
  .filter((p) => p.token_x?.freeze_authority_disabled !== false);
import fs from 'node:fs';
const CACHE = '/tmp/bt48-cache.json';
const pools = [];
const cached = fs.existsSync(CACHE) && args.cache ? JSON.parse(fs.readFileSync(CACHE)) : null;
if (cached) for (const c of cached) pools.push({ ...c, bars: new Map(c.bars) });
else for (const p of universe) {
  const [o, v] = await Promise.all([get(`${API}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`), get(`${API}/pools/${p.address}/volume/history?timeframe=1h&start_time=${start}&end_time=${end}`)]);
  const fees = new Map(v.data.map((x) => [x.timestamp, x.fees - (x.protocol_fees ?? 0)]));
  const bars = new Map(o.data.map((x) => [x.timestamp, { o: x.open, h: x.high, l: x.low, c: x.close, fee: fees.get(x.timestamp) ?? 0 }]));
  const created = p.created_at > 1e12 ? p.created_at / 1000 : p.created_at;
  pools.push({ addr: p.address, sym: p.token_x?.symbol ?? p.name, tvl: Number(p.tvl), binStep: p.pool_config?.bin_step ?? 50, created, bars });
}
if (!cached && args.cache) fs.writeFileSync(CACHE, JSON.stringify(pools.map((p) => ({ ...p, bars: [...p.bars] }))));
const solUsd = (await get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd').catch(() => ({ solana: { usd: 0 } }))).solana.usd;

// concentrated-liquidity position value (DLMM Spot ≈ uniform liquidity over [pa, pb])
const posFromValue = (V, p, pa, pb) => {
  const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), sa = Math.sqrt(pa), sb = Math.sqrt(pb);
  const xPerL = 1 / sp - 1 / sb, yPerL = sp - sa;
  return { L: V / (xPerL * p + yPerL), pa, pb };
};
const posValue = ({ L, pa, pb }, p) => {
  const sa = Math.sqrt(pa), sb = Math.sqrt(pb), sp = Math.sqrt(Math.min(Math.max(p, pa), pb));
  return L * (1 / sp - 1 / sb) * p + L * (sp - sa);
};
const inBandFrac = (b, pa, pb) => { const lo = Math.max(b.l, pa), hi = Math.min(b.h, pb); return b.h > b.l ? Math.max(0, hi - lo) / (b.h - b.l) : (b.c >= pa && b.c <= pb ? 1 : 0); };
const seatCount = (c) => Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.floor(c / SEAT_SOL)));
const seatShare = (rank, n) => { const w = Array.from({ length: n }, (_, i) => W[Math.min(i, W.length - 1)]); const t = w.reduce((a, b) => a + b, 0); return Math.min(Math.max(MAX_SEAT_PCT, 1 / n), w[rank] / t); };

let free = CAPITAL, pot = 0, fees = 0, band = 0, gas = 0, recenters = 0;
const open = new Map(), closed = [], log = [], payouts = [];
const ledger = (pool) => (pool.led ??= { fees: 0, band: 0, cap: 0, sym: pool.sym, enters: 0, exit: null });

const closeSeat = (s, p, reason) => {
  const v = posValue(s.pos, p) * (reason === 'floor' || reason === 'cooled' ? 1 - EXIT_SLIP : 1);
  const pnl = v - s.cost; band += pnl; pot += pnl; ledger(s.pool).band += pnl; free += v; gas += GAS; pot -= GAS;
  open.delete(s.pool.addr); s.pool.led.exit = reason; closed.push(s);
};

for (let t = end - HOURS * 3600; t < end; t += 3600) {
  // 1. tick open seats on this hour's bar
  for (const s of [...open.values()]) {
    const b = s.pool.bars.get(t); if (!b) continue;
    if (b.l <= s.entry * (1 - FLOOR)) { closeSeat(s, s.entry * (1 - FLOOR), 'floor'); log.push(`${new Date(t * 1e3).toISOString().slice(5, 13)}h  FLOOR ${s.pool.sym}`); continue; }
    const f = s.cap * (b.fee / s.pool.tvl) * CAPTURE * inBandFrac(b, s.pos.pa, s.pos.pb);
    fees += f; pot += f; ledger(s.pool).fees += f; free += f;
    if (b.c < s.pos.pa || b.c > s.pos.pb) { // re-center in inventory mode: re-list what we hold, single-sided
      const v = posValue(s.pos, b.c), w = Math.pow(1 + s.pool.binStep / 1e4, BINS) - 1;
      const pnl = v - s.cost; band += pnl; pot += pnl; ledger(s.pool).band += pnl;
      s.pos = b.c > s.pos.pb ? posFromValue(v, b.c, b.c / (1 + w), b.c) : posFromValue(v, b.c, b.c, b.c * (1 + w));
      s.cost = v; recenters++; gas += GAS; pot -= GAS; free -= GAS;
    }
  }
  // 2. scan with only past data
  const scored = pools.filter((p) => (t - p.created) / 3600 >= 6).map((p) => {
    const h1 = p.bars.get(t - 3600)?.fee ?? 0; let d = 0; for (let k = 1; k <= 24; k++) d += p.bars.get(t - k * 3600)?.fee ?? 0;
    let hi = 0, lo = Infinity; for (let k = 1; k <= 24; k++) { const b = p.bars.get(t - k * 3600); if (b) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); } }
    const r1 = (h1 / p.tvl) * 100, r24 = (d / p.tvl) * 100; return { p, r1, rng: lo < Infinity ? hi / lo : 1, score: 0.6 * r1 * 24 + 0.4 * r24 };
  }).filter((x) => x.r1 >= MIN_1H && x.p.bars.get(t) && (!MAX_RANGE || x.rng <= MAX_RANGE)).sort((a, b) => b.score - a.score);
  const deployed = [...open.values()].reduce((a, s) => a + s.cap, 0), cap = free + deployed, n = seatCount(cap);
  const hot = new Set(scored.slice(0, n * 2).map((x) => x.p.addr));
  for (const s of [...open.values()]) { s.miss = hot.has(s.pool.addr) ? 0 : s.miss + 1; if (s.miss >= ROTATE_OUT) { closeSeat(s, s.pool.bars.get(t).o, 'cooled'); } }
  for (const x of scored) {
    if (open.size >= n) break; if (open.has(x.p.addr)) continue;
    const budget = Math.min(cap * seatShare(open.size, n), free); if (budget < MIN_SEAT) break;
    const p0 = x.p.bars.get(t).o, w = Math.pow(1 + x.p.binStep / 1e4, BINS) - 1, v = budget * (1 - ENTRY_SLIP / 2);
    open.set(x.p.addr, { pool: x.p, cap: budget, cost: v, entry: p0, miss: 0, pos: posFromValue(v, p0, p0 / (1 + w), p0 * (1 + w)) });
    free -= budget; pot -= budget - v; band -= budget - v; ledger(x.p).cap += budget; ledger(x.p).enters++; gas += GAS; pot -= GAS;
  }
  // 3. payout clock every 24h
  if ((t - (end - HOURS * 3600) + 3600) % (24 * 3600) === 0) {
    const day = payouts.length + 1, out = Math.max(pot, 0);
    payouts.push({ day, pot, holders: out * SPLIT.holders, ops: out * SPLIT.ops, reserve: out * SPLIT.reserve });
    free -= out * (SPLIT.holders + SPLIT.ops); pot = Math.min(pot, 0);
  }
}
// mark what's still open
let mark = 0; for (const s of open.values()) { const b = [...s.pool.bars.values()].at(-1); const v = posValue(s.pos, b.c); mark += v - s.cost; }
const equity = free + [...open.values()].reduce((a, s) => a + posValue(s.pos, [...s.pool.bars.values()].at(-1).c), 0);
const f = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
const usd = (x) => solUsd ? ` ($${(x * solUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
console.log(`\nDESK walk-forward · last ${HOURS}h · ${CAPITAL} SOL start · capture ×${CAPTURE} · SOL $${solUsd}`);
console.log(`universe ${pools.length} SOL pools · re-centers ${recenters} · gas+slippage counted\n`);
console.log('pool           seats  capital    fees     band      net   exit');
const rows = pools.filter((p) => p.led).sort((a, b) => (b.led.fees + b.led.band) - (a.led.fees + a.led.band));
for (const p of rows) { const l = p.led; console.log(`${l.sym.slice(0, 13).padEnd(13)} ${String(l.enters).padStart(5)} ${l.cap.toFixed(2).padStart(8)} ${f(l.fees).padStart(8)} ${f(l.band).padStart(8)} ${f(l.fees + l.band).padStart(8)}   ${l.exit ?? 'open'}`); }
console.log(`\nfees ${f(fees)} · band ${f(band)} · net realised ${f(fees + band - gas)} SOL`);
for (const p of payouts) console.log(`day ${p.day}: pot ${f(p.pot)} → holders ${p.holders.toFixed(3)}${usd(p.holders)} · OPS ${p.ops.toFixed(3)}${usd(p.ops)} · reserve ${p.reserve.toFixed(3)}`);
const H = payouts.reduce((a, p) => a + p.holders, 0), O = payouts.reduce((a, p) => a + p.ops, 0);
console.log(`\n48h total → holders ${H.toFixed(3)} SOL${usd(H)} · OPS ${O.toFixed(3)} SOL${usd(O)} · desk equity ${equity.toFixed(3)} SOL (unrealised on open seats ${f(mark)})`);
