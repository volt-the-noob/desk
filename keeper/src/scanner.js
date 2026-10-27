import { cfg } from './config.js';
import { log } from './log.js';

const API = 'https://dlmm.datapi.meteora.ag';
const SOL = 'So11111111111111111111111111111111111111112';

/**
 * Rank candidate pools. Score blends what the pool earned per $ of liquidity in the last hour
 * (annualised to a daily rate) with the 24h figure, so a pool that just died drops out fast and
 * a pool that just caught fire shows up fast.
 * Returns [{ address, name, symbol, tokenX, tvl, vol24, fees24, ratio1h, ratio24h, score, ... }] best first.
 */
let verified = { set: null, at: 0 };
async function verifiedSet() {
  if (verified.set && Date.now() - verified.at < 6 * 3600e3) return verified.set;
  try {
    const r = await fetch('https://lite-api.jup.ag/tokens/v2/tag?query=verified');
    const list = await r.json();
    if (Array.isArray(list) && list.length > 100) verified = { set: new Set(list.map((t) => t.id)), at: Date.now() };
  } catch (e) { log.warn(`verified list fetch failed: ${e.message}`); }
  return verified.set;   // null if never fetched: scanPools then returns no candidates rather than unverified ones
}

export async function scanPools() {
  const filter = [
    'is_blacklisted=false',
    `tvl>=${cfg.minTvlUsd}`,
    `volume_24h>=${cfg.minVolume24hUsd}`,
    `token_y=${SOL}`,
  ].join(' && ');
  const url = `${API}/pools?page_size=60&sort_by=fee_tvl_ratio_1h:desc&filter_by=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`scanner: ${res.status} from meteora api`);
  const { data } = await res.json();

  const now = Date.now() / 1000;
  const allow = new Set(cfg.poolAllowlist);
  const deny = new Set(cfg.poolDenylist);
  const denyTok = new Set(cfg.tokenDenylist);
  const seenToken = new Set();
  const out = [];
  const ver = cfg.poolVerifiedOnly ? await verifiedSet() : null;
  if (cfg.poolVerifiedOnly && !ver) { log.warn('scan: no verified token list yet, skipping this scan'); return []; }

  for (const p of data) {
    const addr = p.address;
    if (allow.size && !allow.has(addr)) continue;
    if (deny.has(addr) || denyTok.has(p.token_x?.address)) continue;
    if (ver && !ver.has(p.token_x?.address)) continue;
    if (cfg.requireFreezeDisabled && p.token_x?.freeze_authority_disabled === false) continue;
    const createdSec = p.created_at > 1e12 ? p.created_at / 1000 : p.created_at; // api returns ms
    if ((now - createdSec) / 3600 < cfg.minPoolAgeHours) continue;
    const ratio1h = Number(p.fee_tvl_ratio?.['1h'] ?? 0);
    const ratio24h = Number(p.fee_tvl_ratio?.['24h'] ?? 0);
    if (ratio1h < cfg.minFeeTvl1hPct) continue;
    if (seenToken.has(p.token_x?.address)) continue; // one pool per token
    seenToken.add(p.token_x?.address);
    out.push({
      address: addr,
      name: p.name,
      symbol: p.token_x?.symbol ?? p.name.split('-')[0],
      tokenX: p.token_x?.address,
      decimals: p.token_x?.decimals,
      tvl: Number(p.tvl),
      vol24: Number(p.volume?.['24h'] ?? 0),
      fees24: Number(p.fees?.['24h'] ?? 0),
      ratio1h,
      ratio24h,
      binStep: p.pool_config?.bin_step,
      baseFeePct: p.pool_config?.base_fee_pct,
      launchpad: p.launchpad ?? null,
      createdAt: createdSec,
      score: 0.6 * ratio1h * 24 + 0.4 * ratio24h, venue: 'dlmm',
    });
  }
  out.sort((a, b) => b.score - a.score);
  if (cfg.maxRange24h > 0) {
    // calm-pool mode: only pools whose price stayed within MAX_RANGE_24H over the last day, ranked by
    // fees earned per unit of volatility (24h fee/TVL ÷ 24h range). Raw fee ranking picks the wildest coins,
    // where price swings cost more than the fees pay; this picks pools that pay well for little movement.
    const end = Math.floor(Date.now() / 1000), start = end - 24 * 3600;
    const kept = [];
    for (const c of [...out].sort((a, b) => b.ratio24h - a.ratio24h).slice(0, 40)) {
      try {
        const r = await fetch(`${API}/pools/${c.address}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`);
        const bars = (await r.json()).data ?? [];
        const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
        c.range24h = lo > 0 ? hi / lo : 99;
        c.score = c.ratio24h / Math.max(0.005, c.range24h - 1);
        if (c.range24h <= cfg.maxRange24h) kept.push(c);
      } catch { /* unknown range: skip it */ }
    }
    try {
      for (const p of await pumpswapPools()) {
        if (ver && !ver.has(p.tokenX)) continue;
        if (p.tvl < cfg.minTvlUsd || (now - p.created) / 3600 < cfg.minPoolAgeHours) continue;
        const move = Math.max(Math.abs(p.chg24), Math.abs(p.chg6)) / 100;
        if (1 + move > cfg.maxRange24h) continue;
        const r = psRatios(p);
        kept.push({ ...p, ...r, range24h: 1 + move, fees24: p.vol24 * PS_LP_FEE, score: r.ratio24h / Math.max(0.005, move) });
      }
    } catch (e) { log.warn(`calm scan: pumpswap skipped: ${e.message}`); }
    // one pool per coin across venues: keep the better-scoring one
    const best = new Map(); for (const c of kept) { const o = best.get(c.tokenX); if (!o || c.score > o.score) best.set(c.tokenX, c); }
    kept.length = 0; kept.push(...best.values());
    kept.sort((a, b) => b.score - a.score);
    log.info(`scan: calm pools (24h range ≤ ${cfg.maxRange24h}x) ${kept.length}/${Math.min(out.length, 40)}; top: ${kept.slice(0, 4).map((c) => `${c.symbol} ${c.ratio24h.toFixed(2)}%/${((c.range24h - 1) * 100).toFixed(1)}%`).join(', ')}`);
    return kept;
  }
  log.info(`scan: ${data.length} pools → ${out.length} candidates; top: ${out.slice(0, 5).map((c) => `${c.symbol} ${c.score.toFixed(0)}`).join(', ')}`);
  return out;
}

/**
 * Meme sleeve candidates: busy SOL pools on Meteora DLMM for coins that pass on-chain quality filters from Jupiter
 * (market cap, holders, organic score, mint/freeze authority off, holder concentration, dev balance). Ranked by how much
 * the pool is earning right now. No calm filter here: these are the active ones, protected by stops and the sleeve breaker.
 */
export async function scanMemes() {
  const filter = ['is_blacklisted=false', `tvl>=${cfg.memeMinLiqUsd}`, `volume_24h>=${cfg.memeMinVolumeUsd}`, `token_y=${SOL}`].join(' && ');
  const res = await fetch(`${API}/pools?page_size=80&sort_by=fee_tvl_ratio_1h:desc&filter_by=${encodeURIComponent(filter)}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`meme scan: ${res.status} from meteora api`);
  const { data } = await res.json();
  const now = Date.now() / 1000, deny = new Set(cfg.poolDenylist), denyTok = new Set(cfg.tokenDenylist);
  const pools = data.filter((p) => !deny.has(p.address) && !denyTok.has(p.token_x?.address) && ((now - (p.created_at > 1e12 ? p.created_at / 1000 : p.created_at)) / 3600) >= cfg.memeMinAgeHours);
  let ps = [];
  try { ps = (await pumpswapPools()).filter((p) => p.tvl >= cfg.memeMinLiqUsd && p.vol24 >= cfg.memeMinVolumeUsd && !deny.has(p.address) && !denyTok.has(p.tokenX) && (now - p.created) / 3600 >= cfg.memeMinAgeHours); } catch {}
  const mints = [...new Set([...pools.map((p) => p.token_x.address), ...ps.map((p) => p.tokenX)])];
  const info = new Map();
  for (let i = 0; i < mints.length; i += 50) {
    try { const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.slice(i, i + 50).join(',')}`); for (const t of await r.json()) info.set(t.id, t); } catch (e) { log.warn(`meme scan: jupiter token data failed: ${e.message}`); }
  }
  const out = [], seen = new Set(), why = {};
  const no = (k) => { why[k] = (why[k] ?? 0) + 1; return false; };
  for (const p of pools) {
    const t = info.get(p.token_x.address), a = t?.audit ?? {};
    const ok = t && (t.mcap ?? 0) >= cfg.memeMinMcapUsd || no('mcap');
    if (!ok) continue;
    if ((t.holderCount ?? 0) < cfg.memeMinHolders && !no('holders')) continue;
    if ((t.organicScore ?? 0) < cfg.memeMinOrganic && !no('organic')) continue;
    if ((!a.mintAuthorityDisabled || !a.freezeAuthorityDisabled) && !no('authority')) continue;
    if ((a.topHoldersPercentage ?? 100) > cfg.memeMaxTopHoldersPct && !no('concentration')) continue;
    if ((a.devBalancePercentage ?? 0) > cfg.memeMaxDevPct && !no('dev')) continue;
    if (seen.has(p.token_x.address)) continue; seen.add(p.token_x.address);
    const ratio1h = Number(p.fee_tvl_ratio?.['1h'] ?? 0), ratio24h = Number(p.fee_tvl_ratio?.['24h'] ?? 0);
    out.push({ address: p.address, name: p.name, symbol: p.token_x?.symbol ?? p.name.split('-')[0], tokenX: p.token_x.address, tvl: Number(p.tvl), vol24: Number(p.volume?.['24h'] ?? 0),
      fees24: Number(p.fees?.['24h'] ?? 0), ratio1h, ratio24h, binStep: p.pool_config?.bin_step, mcap: Math.round(t.mcap), holders: t.holderCount, organic: Math.round(t.organicScore ?? 0),
      topHoldersPct: Math.round(a.topHoldersPercentage ?? 0), score: 0.6 * ratio1h * 24 + 0.4 * ratio24h, sleeve: 'meme' });
  }
  for (const p of ps) {
    const t = info.get(p.tokenX), a = t?.audit ?? {};
    if (!t || (t.mcap ?? 0) < cfg.memeMinMcapUsd || (t.holderCount ?? 0) < cfg.memeMinHolders || (t.organicScore ?? 0) < cfg.memeMinOrganic) continue;
    if (!a.mintAuthorityDisabled || !a.freezeAuthorityDisabled || (a.topHoldersPercentage ?? 100) > cfg.memeMaxTopHoldersPct || (a.devBalancePercentage ?? 0) > cfg.memeMaxDevPct) continue;
    const r = psRatios(p);
    const c = { ...p, ...r, fees24: p.vol24 * PS_LP_FEE, mcap: Math.round(t.mcap), holders: t.holderCount, organic: Math.round(t.organicScore ?? 0), topHoldersPct: Math.round(a.topHoldersPercentage ?? 0), score: 0.6 * r.ratio1h * 24 + 0.4 * r.ratio24h, sleeve: 'meme' };
    const i = out.findIndex((o) => o.tokenX === p.tokenX);
    if (i < 0) out.push(c); else if (c.score > out[i].score) out[i] = c;
  }
  for (const c of out) c.venue ??= 'dlmm';
  out.sort((a, b) => b.score - a.score);
  log.info(`meme scan: ${pools.length} meteora + ${ps.length} pumpswap busy pools → ${out.length} pass (dropped: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); top: ${out.slice(0, 4).map((c) => `${c.symbol} ${c.holders}h/${c.organic}org`).join(', ')}`);
  return out;
}

// ---------- PumpSwap pools (GeckoTerminal: the busiest SOL-quoted PumpSwap pools) ----------
let psCache = { at: 0, list: [] };
export async function pumpswapPools() {
  if (Date.now() - psCache.at < 240e3) return psCache.list;
  const out = [];
  for (const page of [1, 2, 3, 4]) {
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?sort=h24_volume_usd_desc&page=${page}`, { headers: { accept: 'application/json' } });
      if (!r.ok) break;
      for (const p of (await r.json()).data ?? []) {
        const a = p.attributes; if (p.relationships.quote_token.data.id !== `solana_${SOL}`) continue;
        const tvl = Number(a.reserve_in_usd), vol = Number(a.volume_usd?.h24 ?? 0);
        if (!(tvl > 0) || vol / tvl > 200) continue;  // dust pools and obvious wash
        out.push({ address: a.address, venue: 'pumpswap', tokenX: p.relationships.base_token.data.id.replace('solana_', ''), symbol: a.name.split(' / ')[0], tvl, vol24: vol,
          created: Date.parse(a.pool_created_at) / 1000, chg24: Number(a.price_change_percentage?.h24 ?? 0), chg6: Number(a.price_change_percentage?.h6 ?? 0),
          vol1: Number(a.volume_usd?.h1 ?? 0) });
      }
    } catch (e) { log.warn(`pumpswap list page ${page}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 2200));
  }
  psCache = { at: Date.now(), list: out };
  return out;
}
const PS_LP_FEE = 0.002;   // PumpSwap LP share of each trade at most market-cap tiers (refined per pool on load)
const psRatios = (p) => ({ ratio24h: (p.vol24 * PS_LP_FEE / p.tvl) * 100, ratio1h: (p.vol1 * PS_LP_FEE / p.tvl) * 100 });
