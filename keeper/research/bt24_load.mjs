// Data for the 24h strategy test: Meteora DLMM + PumpSwap SOL pools, 48h of hourly OHLC + fees, plus coin data from Jupiter.
import fs from 'node:fs';
const SOL = 'So11111111111111111111111111111111111111112', M = 'https://dlmm.datapi.meteora.ag', G = 'https://api.geckoterminal.com/api/v2/networks/solana';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { for (let i = 0; i < 6; i++) { try { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (r.ok) return r.json(); if (r.status === 429 || r.status === 403) await sleep(6000 * (i + 1)); } catch {} await sleep(1500); } throw new Error('fetch ' + u); };
const end = Math.floor(Date.now() / 3600e3) * 3600, start = end - 48 * 3600;
const pools = [];
// Meteora DLMM: busy SOL pools (covers both calm and meme candidates)
const f = encodeURIComponent(`is_blacklisted=false && tvl>=20000 && volume_24h>=200000 && token_y=${SOL}`);
const list = (await get(`${M}/pools?page_size=100&sort_by=volume_24h:desc&filter_by=${f}`)).data;
for (const p of list) {
  try {
    const [o, v] = await Promise.all([get(`${M}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`), get(`${M}/pools/${p.address}/volume/history?timeframe=1h&start_time=${start}&end_time=${end}`)]);
    const fees = new Map(v.data.map((x) => [x.timestamp, x.fees - (x.protocol_fees ?? 0)])), vol = new Map(v.data.map((x) => [x.timestamp, x.volume]));
    pools.push({ venue: 'dlmm', addr: p.address, sym: p.token_x.symbol, mint: p.token_x.address, tvl: Number(p.tvl), binStep: p.pool_config?.bin_step ?? 50,
      created: p.created_at > 1e12 ? p.created_at / 1000 : p.created_at, bars: o.data.map((x) => [x.timestamp, x.open, x.high, x.low, x.close, fees.get(x.timestamp) ?? 0, vol.get(x.timestamp) ?? 0]) });
  } catch (e) { console.log('skip', p.token_x?.symbol, e.message.slice(0, 60)); }
}
console.log('meteora pools', pools.length);
// PumpSwap: busiest SOL pools (4 pages), then hourly bars for the ones with real liquidity and volume
const ps = [];
for (const page of [1, 2, 3, 4]) {
  for (const p of (await get(`${G}/dexes/pumpswap/pools?sort=h24_volume_usd_desc&page=${page}`)).data ?? []) {
    const a = p.attributes; if (p.relationships.quote_token.data.id !== `solana_${SOL}`) continue;
    const tvl = Number(a.reserve_in_usd), vol = Number(a.volume_usd?.h24 ?? 0);
    if (tvl < 20000 || vol < 200000 || vol / tvl > 200) continue;
    ps.push({ addr: a.address, sym: a.name.split(' / ')[0], mint: p.relationships.base_token.data.id.replace('solana_', ''), tvl, created: Date.parse(a.pool_created_at) / 1000 });
  }
  await sleep(2300);
}
// keep only coins that can pass the coin filters at all (saves rate limit): ≥500 holders now
const jupAll = new Map();
const mints = [...new Set([...pools.map((p) => p.mint), ...ps.map((p) => p.mint)])];
for (let i = 0; i < mints.length; i += 50) { for (const t of await get(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.slice(i, i + 50).join(',')}`)) jupAll.set(t.id, t); await sleep(1100); }
const psReal = ps.filter((p) => (jupAll.get(p.mint)?.holderCount ?? 0) >= 500).slice(0, 12);
for (const p of psReal) {
  const t = (await get(`${G}/pools/${p.addr}/ohlcv/hour?aggregate=1&limit=49&currency=token&before_timestamp=${end + 1}`)).data.attributes.ohlcv_list; await sleep(2300);
  const u = (await get(`${G}/pools/${p.addr}/ohlcv/hour?aggregate=1&limit=49&currency=usd&before_timestamp=${end + 1}`)).data.attributes.ohlcv_list; await sleep(2300);
  const vol = new Map(u.map((r) => [r[0], r[5]]));
  pools.push({ venue: 'pumpswap', ...p, binStep: 0, bars: t.map((r) => [r[0], r[1], r[2], r[3], r[4], (vol.get(r[0]) ?? 0) * 0.002, vol.get(r[0]) ?? 0]).sort((a, b) => a[0] - b[0]) });
}
console.log('pumpswap pools (real coins)', psReal.length, 'of', ps.length, 'busy');
const ver = new Set((await get('https://lite-api.jup.ag/tokens/v2/tag?query=verified')).map((t) => t.id));
for (const p of pools) { const t = jupAll.get(p.mint) ?? {}; p.coin = { verified: ver.has(p.mint), mcap: t.mcap ?? 0, holders: t.holderCount ?? 0, organic: t.organicScore ?? 0, mintOff: !!t.audit?.mintAuthorityDisabled, freezeOff: !!t.audit?.freezeAuthorityDisabled, top10: t.audit?.topHoldersPercentage ?? 100, dev: t.audit?.devBalancePercentage ?? 0 }; }
fs.writeFileSync('/tmp/bt24.json', JSON.stringify({ end, pools }));
console.log('saved', pools.length, 'pools; window', new Date((end - 24 * 3600) * 1000).toISOString(), '→', new Date(end * 1000).toISOString());
