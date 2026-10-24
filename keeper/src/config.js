// All runtime knobs live here. Everything is an env var so Railway can flip them without a code redeploy.

const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const bool = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : /^(1|true|yes)$/i.test(process.env[k]));
const str = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k]).trim());
const list = (k) => str(k).split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  // --- chain ---
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  walletSecret: str('WALLET_SECRET'),            // base58 or JSON array of the desk wallet secret key
  priorityFeeMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 50_000),
  txRetries: num('TX_RETRIES', 3),

  // --- safety ---
  dryRun: bool('DRY_RUN', true),                // true = compute + log + ledger, never sign/send
  dryRunSol: num('DRY_RUN_SOL', 0),             // paper-trade with a virtual bankroll (dry-run only)
  gasReserveSol: num('GAS_RESERVE_SOL', 0.15),  // SOL that never leaves the wallet

  // --- which pools (scanner) ---
  scanIntervalSec: num('SCAN_INTERVAL_SEC', 300),
  // seats scale with capital: seats = clamp(floor(capital / SEAT_SOL), MIN_SEATS, MAX_SEATS)
  seatSol: num('SEAT_SOL', 4),
  minSeats: num('MIN_SEATS', 2),
  maxSeats: num('MAX_SEATS', num('MAX_POOLS', 8)),
  seatWeights: list('SEAT_WEIGHTS').map(Number).filter((x) => x > 0), // capital share by rank; default below
  maxSeatPct: num('MAX_SEAT_PCT', 30),                      // no single seat above this % of capital
  minCapitalPerPoolSol: num('MIN_CAPITAL_PER_POOL_SOL', 1.5), // don't open a seat smaller than this
  minTvlUsd: num('MIN_TVL_USD', 50_000),
  minVolume24hUsd: num('MIN_VOLUME_24H_USD', 500_000),
  minPoolAgeHours: num('MIN_POOL_AGE_HOURS', 6),
  minFeeTvl1hPct: num('MIN_FEE_TVL_1H_PCT', 0.3),          // pool must still be earning right now
  requireFreezeDisabled: bool('REQUIRE_FREEZE_DISABLED', true),
  poolAllowlist: list('POOL_ALLOWLIST'),        // if set, only these pools are ever used (still ranked/filtered)
  poolDenylist: list('POOL_DENYLIST'),
  tokenDenylist: list('TOKEN_DENYLIST'),

  // --- when a pool gets closed (rotation) ---
  rotateOutScans: num('ROTATE_OUT_SCANS', 3),   // consecutive scans outside the top candidates before we exit
  maxHoldHours: num('MAX_HOLD_HOURS', 0),       // 0 = no time limit
  exitSellInventory: bool('EXIT_SELL_INVENTORY', true), // on exit, sell the pool's token back to SOL

  // --- band ---
  binsBelow: num('BINS_BELOW', 20),
  binsAbove: num('BINS_ABOVE', 20),
  strategy: str('STRATEGY', 'Spot'),            // Spot | Curve | BidAsk
  entryMode: str('ENTRY_MODE', 'balanced'),     // balanced = buy X first then LP both sides; bid = SOL-only bids below price
  balancedXPct: num('BALANCED_X_PCT', 50),
  rebalanceMode: str('REBALANCE_MODE', 'inventory'), // inventory | balanced
  outOfRangeTicks: num('OUT_OF_RANGE_TICKS', 2),
  rebalanceCooldownSec: num('REBALANCE_COOLDOWN_SEC', 60),
  addLiquiditySlippagePct: num('ADD_LIQ_SLIPPAGE_PCT', 2),
  swapSlippageBps: num('SWAP_SLIPPAGE_BPS', 300),

  // --- floor stop (per pool) ---
  floorPctBelowEntry: num('FLOOR_PCT_BELOW_ENTRY', 35), // 35 → floor at 65% of the pool's entry price (0 = off)

  // --- harvest ---
  harvestIntervalSec: num('HARVEST_INTERVAL_SEC', 300),
  harvestMinSol: num('HARVEST_MIN_SOL', 0.01),
  sellFeeX: bool('SELL_FEE_X', true),
  minSellXSol: num('MIN_SELL_X_SOL', 0.005),

  // --- payouts: every PAYOUT_INTERVAL_HOURS, split the pot ---
  holderTokenMint: str('HOLDER_TOKEN_MINT'),    // YOUR token — whose holders get paid
  opsWallet: str('OPS_WALLET'),
  holderSharePct: num('HOLDER_SHARE_PCT', 50),
  reserveSharePct: num('RESERVE_SHARE_PCT', 30), // stays in the desk as capital
  opsSharePct: num('OPS_SHARE_PCT', 20),
  payoutIntervalHours: num('PAYOUT_INTERVAL_HOURS', 24),
  payoutThresholdSol: num('PAYOUT_THRESHOLD_SOL', 0), // optional early trigger on the holder share (0 = clock only)
  minPayoutSol: num('MIN_PAYOUT_SOL', 0.002),   // per-wallet dust floor; smaller accrues
  minHoldTokens: num('MIN_HOLD_TOKENS', 0),
  maxHolders: num('MAX_HOLDERS', 20000),
  excludeWallets: list('EXCLUDE_WALLETS'),
  transfersPerTx: num('TRANSFERS_PER_TX', 14),

  // --- loop ---
  tickMs: num('TICK_MS', 15_000),
  snapshotIntervalSec: num('SNAPSHOT_INTERVAL_SEC', 900), // equity history row for the site chart
  port: num('PORT', 8080),

  // --- ledger ---
  supabaseUrl: str('SUPABASE_URL'),
  supabaseKey: str('SUPABASE_SERVICE_KEY'),
  deskName: str('DESK_NAME', 'desk'),
};

if (!cfg.seatWeights.length) cfg.seatWeights = [30, 22, 16, 12, 8, 6, 3, 3];

/** How many seats the fund should run at this capital. */
export function seatCount(capitalSol) {
  return Math.max(cfg.minSeats, Math.min(cfg.maxSeats, Math.floor(capitalSol / cfg.seatSol)));
}

/** Capital share for seat `rank` (0 = best) when `seats` seats are open: weights renormalised, capped. */
export function seatShare(rank, seats) {
  const w = Array.from({ length: seats }, (_, i) => cfg.seatWeights[Math.min(i, cfg.seatWeights.length - 1)]);
  const total = w.reduce((a, b) => a + b, 0);
  const cap = Math.max(cfg.maxSeatPct / 100, 1 / seats); // with 2 seats a 30% cap would idle capital
  return Math.min(cap, w[Math.min(rank, seats - 1)] / total);
}

export function assertConfig() {
  const missing = [];
  if (!cfg.walletSecret) missing.push('WALLET_SECRET');
  if (!cfg.supabaseUrl) missing.push('SUPABASE_URL');
  if (!cfg.supabaseKey && cfg.supabaseUrl !== 'memory') missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  if (cfg.holderSharePct + cfg.reserveSharePct + cfg.opsSharePct !== 100) throw new Error('HOLDER_SHARE_PCT + RESERVE_SHARE_PCT + OPS_SHARE_PCT must be 100');
  if (!['Spot', 'Curve', 'BidAsk'].includes(cfg.strategy)) throw new Error('STRATEGY must be Spot|Curve|BidAsk');
  if (!['balanced', 'bid'].includes(cfg.entryMode)) throw new Error('ENTRY_MODE must be balanced|bid');
  if (!['inventory', 'balanced'].includes(cfg.rebalanceMode)) throw new Error('REBALANCE_MODE must be inventory|balanced');
  if (cfg.binsBelow + cfg.binsAbove + 1 > 69) throw new Error('BINS_BELOW + BINS_ABOVE must be ≤ 68');
  if (cfg.minSeats < 1 || cfg.maxSeats < cfg.minSeats) throw new Error('MIN_SEATS/MAX_SEATS invalid');
  if (!cfg.holderTokenMint) console.warn('HOLDER_TOKEN_MINT not set: holder share accrues in the pot until it is');
  if (!cfg.opsWallet) console.warn('OPS_WALLET not set: ops share stays in the desk as reserve');
}
