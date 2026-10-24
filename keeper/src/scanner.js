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

  for (const p of data) {
    const addr = p.address;
    if (allow.size && !allow.has(addr)) continue;
    if (deny.has(addr) || denyTok.has(p.token_x?.address)) continue;
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
      score: 0.6 * ratio1h * 24 + 0.4 * ratio24h,
    });
  }
  out.sort((a, b) => b.score - a.score);
  log.info(`scan: ${data.length} pools → ${out.length} candidates; top: ${out.slice(0, 5).map((c) => `${c.symbol} ${c.score.toFixed(0)}`).join(', ')}`);
  return out;
}
