// Load hourly pool data for one window into a cache file. usage: node bt_load.mjs --offset 0|48 --out file [--venue meteora|pumpswap|majors]
import fs from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
const OFF = Number(args.offset ?? 0), HOURS = 48, V = args.venue;
const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { for (let i = 0; i < 6; i++) { try { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (r.ok) return r.json(); if (r.status === 429) await sleep(7000); } catch {} await sleep(1500 * (i + 1)); } throw new Error('fetch ' + u); };
const end = Math.floor(Date.now() / 3600e3) * 3600 - OFF * 3600, start = end - (HOURS + 24) * 3600;
const M = 'https://dlmm.datapi.meteora.ag';
const out = [];
async function meteoraPool(p, invert = false) {
  const [o, v] = await Promise.all([get(`${M}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`), get(`${M}/pools/${p.address}/volume/history?timeframe=1h&start_time=${start}&end_time=${end}`)]);
  const fees = new Map(v.data.map((x) => [x.timestamp, x.fees - (x.protocol_fees ?? 0)]));
  const bar = (x) => invert ? [x.timestamp, 1 / x.open, 1 / x.low, 1 / x.high, 1 / x.close, fees.get(x.timestamp) ?? 0] : [x.timestamp, x.open, x.high, x.low, x.close, fees.get(x.timestamp) ?? 0];
  return { venue: invert ? 'major' : 'meteora', addr: p.address, mint: invert ? p.token_y.address : p.token_x.address, sym: invert ? `${p.token_y.symbol}(vs SOL)` : p.token_x.symbol, launchpad: p.launchpad || '', tvl: Number(p.tvl), binStep: p.pool_config?.bin_step ?? 50, created: p.created_at > 1e12 ? p.created_at / 1000 : p.created_at, bars: o.data.map(bar) };
}
if (V === 'meteora') {
  const f = encodeURIComponent(`is_blacklisted=false && tvl>=50000 && volume_24h>=300000 && token_y=${SOL}`);
  for (const p of (await get(`${M}/pools?page_size=100&sort_by=volume_24h:desc&filter_by=${f}`)).data) { if (p.token_x?.freeze_authority_disabled === false) continue; out.push(await meteoraPool(p)); }
}
if (V === 'majors') {
  // SOL/USDC (inverted so the "token" is USDC priced in SOL) + LST/SOL pools
  const f1 = encodeURIComponent(`is_blacklisted=false && tvl>=200000 && token_x=${SOL} && token_y=${USDC}`);
  for (const p of (await get(`${M}/pools?page_size=4&sort_by=volume_24h:desc&filter_by=${f1}`)).data) out.push(await meteoraPool(p, true));
  const f2 = encodeURIComponent(`is_blacklisted=false && tvl>=200000 && token_y=${SOL}`);
  const lst = /SOL$|^INF$|^mSOL$|^JitoSOL$|^jupSOL$|^bSOL$|^dSOL$|^hSOL$|^bbSOL$/;
  for (const p of (await get(`${M}/pools?page_size=100&sort_by=tvl:desc&filter_by=${f2}`)).data) if (lst.test(p.token_x?.symbol ?? '') && p.token_x.symbol !== 'SOL') out.push(await meteoraPool(p));
}
if (V === 'pumpswap') {
  const G = 'https://api.geckoterminal.com/api/v2/networks/solana';
  const pools = [];
  for (let page = 1; page <= 5; page++) {
    for (const p of (await get(`${G}/dexes/pumpswap/pools?sort=h24_volume_usd_desc&page=${page}`)).data) {
      const a = p.attributes; if (p.relationships.quote_token.data.id !== `solana_${SOL}`) continue;
      const tvl = Number(a.reserve_in_usd), vol = Number(a.volume_usd.h24);
      if (tvl < 50000 || vol < 300000 || vol / tvl > 200) continue;
      pools.push({ addr: a.address, mint: p.relationships.base_token.data.id.replace('solana_', ''), sym: a.name.split(' / ')[0], tvl, created: Date.parse(a.pool_created_at) / 1000 });
    }
    await sleep(2300);
  }
  for (const p of pools.slice(0, 25)) {
    const q = `aggregate=1&limit=${HOURS + 25}&before_timestamp=${end}`;
    const t = await get(`${G}/pools/${p.addr}/ohlcv/hour?${q}&currency=token`); await sleep(2300);
    const u = await get(`${G}/pools/${p.addr}/ohlcv/hour?${q}&currency=usd`); await sleep(2300);
    const vol = new Map((u.data.attributes.ohlcv_list || []).map((r) => [r[0], r[5]]));
    out.push({ venue: 'pumpswap', ...p, launchpad: 'pump.fun', binStep: 0, bars: (t.data.attributes.ohlcv_list || []).map((r) => [r[0], r[1], r[2], r[3], r[4], (vol.get(r[0]) ?? 0) * 0.002]).sort((a, b) => a[0] - b[0]) });
  }
}
fs.writeFileSync(args.out, JSON.stringify({ end, hours: HOURS, pools: out }));
console.log(V, 'offset', OFF, 'pools', out.length, out.map((p) => p.sym).slice(0, 12).join(' '));
