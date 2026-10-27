// Tokens that trade against SOL on 2+ venues with real liquidity, from DexScreener; mapped to Jupiter venue labels.
import fs from 'node:fs';
const SOL = 'So11111111111111111111111111111111111111112';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const map = (p) => {
  const l = (p.labels || []).join(','), d = p.dexId;
  if (d === 'pumpswap') return 'Pump.fun Amm';
  if (d === 'meteora') return l.includes('DLMM') ? 'Meteora DLMM' : l.includes('DYN2') ? 'Meteora DAMM v2' : l.includes('DYN') ? 'Meteora' : null;
  if (d === 'raydium') return l.includes('CLMM') ? 'Raydium CLMM' : l.includes('CPMM') ? 'Raydium CP' : 'Raydium';
  if (d === 'orca') return 'Whirlpool';
  return null;
};
// seed tokens: top SOL pools on Meteora + trending/boosted Solana tokens
const seeds = new Set();
const f = encodeURIComponent(`is_blacklisted=false && tvl>=30000 && volume_24h>=200000 && token_y=${SOL}`);
for (const p of (await (await fetch(`https://dlmm.datapi.meteora.ag/pools?page_size=60&sort_by=volume_24h:desc&filter_by=${f}`)).json()).data ?? []) seeds.add(p.token_x.address);
for (const u of ['https://api.dexscreener.com/token-boosts/top/v1', 'https://api.dexscreener.com/token-boosts/latest/v1']) {
  try { for (const t of await (await fetch(u)).json()) if (t.chainId === 'solana') seeds.add(t.tokenAddress); } catch {}
}
const mints = [...seeds]; console.log('seed tokens', mints.length);
const uni = [];
for (let i = 0; i < mints.length; i += 1) {
  const pairs = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mints[i]}`)).json();
  const by = {};
  for (const p of pairs) {
    if (p.quoteToken?.address !== SOL || (p.liquidity?.usd ?? 0) < 15000) continue;
    const v = map(p); if (!v) continue;
    const m = p.baseToken.address; by[m] ??= { mint: m, sym: p.baseToken.symbol, venues: {} };
    const cur = by[m].venues[v]; if (!cur || cur.liq < p.liquidity.usd) by[m].venues[v] = { liq: Math.round(p.liquidity.usd), vol: Math.round(p.volume?.h24 ?? 0), pair: p.pairAddress };
  }
  for (const t of Object.values(by)) if (Object.keys(t.venues).length >= 2) uni.push(t);
  await sleep(250);
}
uni.sort((a, b) => Object.values(b.venues).reduce((s, v) => s + v.vol, 0) - Object.values(a.venues).reduce((s, v) => s + v.vol, 0));
fs.writeFileSync('/tmp/arb-universe.json', JSON.stringify(uni));
console.log('tokens on 2+ venues (SOL pairs, ≥$15k liquidity):', uni.length);
for (const t of uni.slice(0, 30)) console.log(' ', t.sym.padEnd(10), Object.entries(t.venues).map(([v, x]) => `${v} $${(x.liq / 1000).toFixed(0)}k`).join(' | '));
