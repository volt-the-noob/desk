import { solBalance, tokenBalanceRaw, unwrapWsol, solUsd } from './chain.js';
import { buybackAndBurn } from './buyback.js';
import { Income } from './income.js';
import { StockDesk } from './stockdesk.js';
import { FeeClaimer } from './claim.js';
import { snapshotHolders } from './holders.js';
import { Pool } from './dlmm.js';
import { Band } from './band.js';
import { scanPools } from './scanner.js';
import { mintInfo } from './holders.js';
import { runPayout } from './payout.js';
import { ledger } from './ledger.js';
import { cfg, seatCount, seatShare } from './config.js';
import { log } from './log.js';

const now = () => Date.now();
const iso = (t) => (t ? new Date(t).toISOString() : null);
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The fund owns the wallet, the pot and the clock. Bands own one pool each.
 *   pot += fees harvested + band P&L on every close (per band, booked here)
 *   every PAYOUT_INTERVAL_HOURS: holders 50% · reserve 30% (stays as capital) · ops 20%
 *   a negative pot carries forward; nothing is paid until it's positive again
 */
export class Fund {
  constructor(wallet) {
    this.wallet = wallet;
    this.bands = new Map(); // pool address → Band
    this.s = {
      status: 'running',
      pot: 0, feesTotal: 0, bandPnlTotal: 0, allocatedTotal: 0, paidTotal: 0, opsTotal: 0, reserveTotal: 0, unpaidOwed: 0,
      paidTotalUsd: 0, opsTotalUsd: 0, buybackTotalSol: 0, buybackTotalUsd: 0, burnedTotal: 0, startEquity: null,
      eligibleSupply: null, holdersCount: null, lastHolderScanAt: 0, incomeTotal: 0, stockPnlUsd: 0, stockTrades: 0,
      lastPayoutAt: 0, lastScanAt: 0, lastSnapshotAt: 0,
    };
    this.candidates = [];
    this.holderToken = null;
    this.income = new Income(this);
    this.stocks = new StockDesk(this);
    this.claimer = new FeeClaimer(this);
    // paper-trading bankroll: balances and swaps simulated against real pool quotes
    this.virt = cfg.dryRun && cfg.dryRunSol > 0 ? { sol: cfg.dryRunSol, tokens: new Map() } : null;
  }

  // ---------- boot ----------
  async boot() {
    const row = await ledger.loadState();
    if (row) {
      const s = this.s;
      s.status = row.status ?? 'running';
      for (const [k, col] of Object.entries({ pot: 'pot_sol', feesTotal: 'fees_total_sol', bandPnlTotal: 'band_pnl_total_sol', allocatedTotal: 'allocated_total_sol', paidTotal: 'paid_total_sol', opsTotal: 'ops_total_sol', reserveTotal: 'reserve_total_sol', unpaidOwed: 'unpaid_owed_sol', paidTotalUsd: 'paid_total_usd', opsTotalUsd: 'ops_total_usd', buybackTotalSol: 'buyback_total_sol', buybackTotalUsd: 'buyback_total_usd', burnedTotal: 'burned_total_tokens', incomeTotal: 'income_total_sol', stockPnlUsd: 'stock_pnl_usd', stockTrades: 'stock_trades' })) s[k] = Number(row[col] ?? 0);
      s.startEquity = row.start_equity_sol != null ? Number(row.start_equity_sol) : null;
      this.stocks.restore(row);
      s.lastPayoutAt = row.last_payout_at ? Date.parse(row.last_payout_at) : 0;
    }
    if (!this.s.lastPayoutAt) this.s.lastPayoutAt = now(); // first payout one interval after first boot
    if (cfg.holderTokenMint) {
      this.holderToken = await mintInfo(cfg.holderTokenMint);
      log.info(`holder token ${cfg.holderTokenMint} (${this.holderToken.decimals} dec)`);
    }
    for (const prow of await ledger.openPools()) {
      try {
        const pool = await Pool.load(prow.pool_address);
        const band = Band.hydrate(this, pool, prow);
        this.bands.set(band.address, band);
        log.info(`resumed band ${band.tag()} capital ${band.s.capitalSol} SOL`);
      } catch (e) { log.error(`could not resume pool ${prow.pool_address}: ${e.message}`); }
    }
    if (!cfg.dryRun) await unwrapWsol(this.wallet).catch(() => {});
    await ledger.event('boot', { detail: { dry_run: cfg.dryRun, status: this.s.status, pools: [...this.bands.keys()] } });
    log.info(`fund booted: status=${this.s.status} pot=${this.s.pot.toFixed(4)} bands=${this.bands.size} dryRun=${cfg.dryRun}`);
  }

  // ---------- wallet / paper bankroll ----------
  async freeSol() { return this.virt ? this.virt.sol : solBalance(this.wallet.publicKey); }

  async balances(pool) {
    if (this.virt) {
      const xRaw = this.virt.tokens.get(pool.mintX.toBase58()) ?? 0n;
      return { freeSol: this.virt.sol, xRaw, xUi: pool.xUi(xRaw) };
    }
    const freeSol = await solBalance(this.wallet.publicKey);
    const xRaw = await tokenBalanceRaw(this.wallet.publicKey, pool.mintX, pool.programX);
    return { freeSol, xRaw, xUi: pool.xUi(xRaw) };
  }

  async swap(pool, args) {
    const r = await pool.swap(this.wallet, args);
    if (this.virt) {
      const k = pool.mintX.toBase58();
      const have = this.virt.tokens.get(k) ?? 0n;
      if (args.swapForY) { this.virt.tokens.set(k, have - r.inRaw); this.virt.sol += Number(r.outRaw) / 1e9; }
      else { this.virt.sol -= Number(r.inRaw) / 1e9; this.virt.tokens.set(k, have + r.outRaw); }
    }
    return r;
  }

  onDeposit(pool, yLamports, xRaw) {
    if (!this.virt) return;
    const k = pool.mintX.toBase58();
    this.virt.sol -= Number(yLamports) / 1e9;
    this.virt.tokens.set(k, (this.virt.tokens.get(k) ?? 0n) - xRaw);
  }

  onPaperFees(sol) { if (this.virt) this.virt.sol += sol; }
  onPaperSpend(sol) { if (this.virt) this.virt.sol -= sol; }

  poolsOn() { return cfg.poolsEnabled && (!cfg.poolsStartAt || Date.now() >= Date.parse(cfg.poolsStartAt)); }

  /** Revenue that isn't market making: creator-fee sweeps, and (live mode) realised stock-desk profit. */
  async onIncome(sol, sig, source) {
    this.s.pot += sol;
    this.s.incomeTotal += sol;
    if (this.virt) this.virt.sol += sol;
    log.info(`income +${sol.toFixed(4)} SOL (${source}) → pot ${this.s.pot.toFixed(4)}`);
    await ledger.event('income', { solDelta: sol, txs: sig ? [sig] : [], detail: { source, sol } });
  }

  onWithdraw(pool, ySol, xRaw) {
    if (!this.virt) return;
    const k = pool.mintX.toBase58();
    this.virt.sol += ySol;
    this.virt.tokens.set(k, (this.virt.tokens.get(k) ?? 0n) + xRaw);
  }

  // ---------- pot ----------
  owedHolders() { return (cfg.holderSharePct / 100) * Math.max(this.s.pot, 0); }
  owedOps() { return (cfg.opsSharePct / 100) * Math.max(this.s.pot, 0); }
  owedBuyback() { return (cfg.buybackSharePct / 100) * Math.max(this.s.pot, 0); }
  /** SOL that must stay out of the bands: gas + what's owed to holders and ops + accrued dust. */
  holdSol() { return cfg.gasReserveSol + this.owedHolders() + this.owedOps() + this.owedBuyback() + this.s.unpaidOwed; }

  async book(kind, band, { solDelta = 0, bandPnl = 0, fees = 0, price = null, txs = [], detail = {} }) {
    this.s.pot += solDelta;
    this.s.feesTotal += fees;
    this.s.bandPnlTotal += bandPnl;
    band.s.feesSol += fees;
    band.s.bandPnlSol += bandPnl;
    log.info(`${band.tag()} ${kind}: ${solDelta >= 0 ? '+' : ''}${solDelta.toFixed(4)} SOL (fees ${fees.toFixed(4)}, band ${bandPnl >= 0 ? '+' : ''}${bandPnl.toFixed(4)}) → pot ${this.s.pot.toFixed(4)}`);
    await this.event(kind, band, { solDelta: r6(solDelta), price, txs, detail: { fees_sol: r6(fees), band_pnl_sol: r6(bandPnl), ...detail } });
  }

  async event(kind, band, { solDelta = 0, price = null, txs = [], detail = {} } = {}) {
    await ledger.event(kind, { solDelta, price, txs, detail: { pool: band?.address, symbol: band?.symbol, ...detail } });
  }

  async refreshStatusFromDb() {
    try {
      const row = await ledger.loadState();
      if (row?.status && row.status !== this.s.status) { log.info(`status changed in ledger: ${this.s.status} → ${row.status}`); this.s.status = row.status; }
    } catch { /* keep going */ }
  }

  openBands() { return [...this.bands.values()].filter((b) => b.s.status === 'open'); }

  // ---------- main loop ----------
  async tick() {
    await this.refreshStatusFromDb();
    if (this.s.status === 'running' && !this.poolsOn() && !this.openBands().length) {
      // pool desk not started yet (day 2): nothing to do here
    } else if (this.s.status === 'running') {
      if (!this.poolsLogged && this.poolsOn()) { this.poolsLogged = true; log.info('pool desk is on'); await ledger.event('pools-on', { detail: { at: new Date().toISOString() } }); }
      for (const band of this.openBands()) {
        try { await band.tick(); } catch (e) { log.error(`${band.tag()} tick failed: ${e.message}`); }
      }
      if (this.poolsOn() && now() - this.s.lastScanAt >= cfg.scanIntervalSec * 1000) {
        try { await this.rotate(); } catch (e) { log.error(`rotate failed: ${e.message}`); }
      }
    } else if (this.s.status === 'exit-all') {
      for (const band of this.openBands()) { try { await band.exit('manual'); } catch (e) { log.error(`${band.tag()} exit failed: ${e.message}`); } }
      this.s.status = 'paused';
      await ledger.saveState({ status: 'paused' });
    }
    try { await this.claimer.tick(); } catch (e) { log.error(`fee claim failed: ${e.message}`); }
    try { await this.income.sweep(); } catch (e) { log.error(`income sweep failed: ${e.message}`); }
    try { await this.stocks.tick(); } catch (e) { log.error(`stock desk tick failed: ${e.message}`); }
    if (this.payoutDue()) await this.payout();
    await this.mark();
  }

  // ---------- rotation ----------
  /** Fund capital = free SOL above the hold + what the open seats were given. */
  async fundCapital() {
    const free = Math.max(0, (await this.freeSol()) - this.holdSol());
    const deployed = this.openBands().reduce((s, b) => s + b.s.capitalSol, 0);
    return { free, deployed, capital: free + deployed };
  }

  /** Budget for the next seat: its rank's share of capital, never more than what's free. */
  async budgetForNewPool() {
    const { free, capital } = await this.fundCapital();
    const seats = seatCount(capital);
    const rank = this.openBands().length;
    if (rank >= seats) return 0;
    return Math.max(0, Math.min(capital * seatShare(rank, seats), free));
  }

  async rotate() {
    const candidates = await scanPools();
    this.candidates = candidates;
    this.s.lastScanAt = now();
    const { capital } = await this.fundCapital();
    const seats = seatCount(capital);
    this.seats = seats;
    const stillHot = new Set(candidates.slice(0, seats * 2).map((c) => c.address));

    // 1. cool-off exits
    for (const band of this.openBands()) {
      const c = candidates.find((x) => x.address === band.address);
      band.s.lastScore = c?.score ?? null;
      band.s.lastRatio1h = c?.ratio1h ?? 0;
      band.s.missScans = stillHot.has(band.address) ? 0 : band.s.missScans + 1;
      if (band.s.missScans >= cfg.rotateOutScans) {
        try { await band.exit('cooled'); } catch (e) { log.error(`${band.tag()} exit failed: ${e.message}`); }
      }
    }

    // 2. fill empty seats, best candidate first
    const openTokens = new Set(this.openBands().map((b) => b.pool.mintX.toBase58()));
    for (const c of candidates) {
      if (this.openBands().length >= seats) break;
      if (this.bands.get(c.address)?.s.status === 'open' || openTokens.has(c.tokenX)) continue;
      const budget = await this.budgetForNewPool();
      if (budget < cfg.minCapitalPerPoolSol) { log.info(`rotate: ${budget.toFixed(3)} SOL free, below MIN_CAPITAL_PER_POOL_SOL; not opening more`); break; }
      try {
        const pool = await Pool.load(c.address);
        const band = new Band(this, pool, c);
        band.s.lastRatio1h = c.ratio1h;
        this.bands.set(band.address, band);
        await band.enter(budget);
        openTokens.add(c.tokenX);
        log.info(`rotate: entered ${band.tag()} with ${budget.toFixed(3)} SOL as seat ${this.openBands().length}/${seats} (score ${c.score.toFixed(0)}, fee/tvl 1h ${c.ratio1h}%)`);
      } catch (e) {
        log.error(`rotate: could not enter ${c.symbol} (${c.address}): ${e.message}`);
        this.bands.delete(c.address);
      }
    }
    await ledger.event('scan', { detail: { candidates: candidates.slice(0, 10).map((c) => ({ symbol: c.symbol, pool: c.address, score: Math.round(c.score), fee_tvl_1h: c.ratio1h, fee_tvl_24h: c.ratio24h, vol24: Math.round(c.vol24) })), open: this.openBands().map((b) => b.symbol) } });
  }

  // ---------- payouts ----------
  nextPayoutAt() { return this.s.lastPayoutAt + cfg.payoutIntervalHours * 3600e3; }

  payoutDue() {
    if (now() >= this.nextPayoutAt()) return true;
    return cfg.payoutThresholdSol > 0 && this.owedHolders() >= cfg.payoutThresholdSol;
  }

  async payout() {
    const potBefore = this.s.pot;
    this.s.lastPayoutAt = now();
    if (potBefore <= 0.0001) {
      log.warn(`payout clock: pot is ${potBefore.toFixed(4)} SOL, nothing to distribute this period`);
      await ledger.event('payout-skipped', { detail: { pot: r6(potBefore) } });
      return;
    }
    const holderSol = this.owedHolders();
    const opsSol = this.owedOps();
    const buybackSol = this.owedBuyback();
    const reserveSol = (cfg.reserveSharePct / 100) * potBefore;
    const px = (await solUsd()) ?? 0;
    const available = (await this.freeSol()) - cfg.gasReserveSol - this.s.unpaidOwed;
    const res = await runPayout({ holderToken: this.holderToken, wallet: this.wallet, holderSol, opsSol, availableSol: available, potBefore, solUsd: px });

    let bb = { sol: 0, tokensBurned: 0, txs: [] };
    if (buybackSol > 0 && this.holderToken) {
      try { bb = await buybackAndBurn({ wallet: this.wallet, holderToken: this.holderToken, sol: Math.min(buybackSol, Math.max(0, available - res.paid - res.opsPaid)) }); }
      catch (e) { log.error(`buyback failed, share stays in the pot: ${e.message}`); }
      if (bb.sol > 0) await ledger.event('buyback', { solDelta: -bb.sol, txs: bb.txs, detail: { sol: bb.sol, sol_usd: px, venue: bb.venue, tokens_bought: bb.tokensBought, tokens_burned: bb.tokensBurned } });
    }

    const opsTaken = cfg.opsWallet ? res.opsPaid : 0;
    this.s.pot -= res.allocated + opsTaken + reserveSol + bb.sol;
    this.s.allocatedTotal += res.allocated;
    this.s.paidTotal += res.paid;
    this.s.paidTotalUsd += res.paid * px;
    this.s.opsTotal += opsTaken;
    this.s.opsTotalUsd += opsTaken * px;
    this.s.reserveTotal += reserveSol;
    this.s.buybackTotalSol += bb.sol;
    this.s.buybackTotalUsd += bb.sol * px;
    this.s.burnedTotal += bb.tokensBurned;
    this.s.unpaidOwed = cfg.dryRun ? Math.max(0, this.s.unpaidOwed + res.allocated - res.paid) : await ledger.unpaidTotal();
    if (this.virt) this.virt.sol -= res.paid + opsTaken + bb.sol;
    await ledger.event('payout', { detail: { pot_before: r6(potBefore), pot_after: r6(this.s.pot), holders_sol: r6(res.allocated), holders_paid_sol: r6(res.paid), ops_sol: r6(opsTaken), reserve_sol: r6(reserveSol), buyback_sol: r6(bb.sol), burned_tokens: bb.tokensBurned, sol_usd: px, wallets: res.walletsPaid, holders: res.holders, tx_count: res.txCount, payout_id: res.payoutId } });
  }

  /** Eligible supply + holder count, for the site's payout estimator. Heavy (getProgramAccounts), so hourly. */
  async refreshHolders() {
    if (!this.holderToken || now() - this.s.lastHolderScanAt < 3600e3) return;
    this.s.lastHolderScanAt = now();
    try {
      const hs = await snapshotHolders(this.holderToken, this.wallet.publicKey);
      this.s.holdersCount = hs.length;
      this.s.eligibleSupply = Number(hs.reduce((a, h) => a + h.raw, 0n)) / 10 ** this.holderToken.decimals;
    } catch (e) { log.warn(`holder refresh failed: ${e.message}`); }
  }

  async mark() {
    await this.refreshHolders();
    const px = await solUsd();
    const freeSol = await this.freeSol();
    let deployed = 0;
    for (const b of this.openBands()) { try { deployed += await b.value(); } catch { deployed += b.s.capitalSol; } }
    let stockUsd = 0; try { stockUsd = await this.stocks.valueUsd(); } catch {}
    const stockSol = px ? stockUsd / px : 0;
    deployed += stockSol;
    const s = this.s;
    if (s.startEquity == null) s.startEquity = r6(freeSol + deployed);
    await ledger.saveState({
      sol_usd: px, start_equity_sol: s.startEquity, profit_total_sol: r6(s.feesTotal + s.bandPnlTotal),
      paid_total_usd: r6(s.paidTotalUsd), ops_total_usd: r6(s.opsTotalUsd), buyback_total_sol: r6(s.buybackTotalSol), buyback_total_usd: r6(s.buybackTotalUsd), burned_total_tokens: s.burnedTotal,
      eligible_supply: s.eligibleSupply, holders_count: s.holdersCount,
      income_total_sol: r6(s.incomeTotal), stock_pnl_usd: Math.round(s.stockPnlUsd * 100) / 100, stock_trades: s.stockTrades, stock_mode: cfg.stockMode,
      stock: this.stocks.view(), stock_book_usd: Math.round(stockUsd * 100) / 100, stock_swept_usd: this.stocks.sweptUsd, stock_realised_usd: this.stocks.realisedUsd, stock_virtual: this.stocks.v, pools_on: this.poolsOn(), pools_start_at: cfg.poolsStartAt || null, fee_claim: this.claimer.view(),
      wallet: this.wallet.publicKey.toBase58(), holder_token_mint: cfg.holderTokenMint || null, ops_wallet: cfg.opsWallet || null,
      dry_run: cfg.dryRun, status: s.status,
      pot_sol: r6(s.pot), fees_total_sol: r6(s.feesTotal), band_pnl_total_sol: r6(s.bandPnlTotal),
      allocated_total_sol: r6(s.allocatedTotal), paid_total_sol: r6(s.paidTotal), ops_total_sol: r6(s.opsTotal), reserve_total_sol: r6(s.reserveTotal), unpaid_owed_sol: r6(s.unpaidOwed),
      equity_sol: r6(freeSol + deployed), free_sol: r6(freeSol), deployed_sol: r6(deployed), open_pools: this.openBands().length,
      last_tick_at: iso(now()), last_scan_at: iso(s.lastScanAt), last_payout_at: iso(s.lastPayoutAt), next_payout_at: iso(this.nextPayoutAt()),
      candidates: this.candidates.slice(0, 8).map((c) => ({ symbol: c.symbol, pool: c.address, score: Math.round(c.score), fee_tvl_1h: c.ratio1h, fee_tvl_24h: c.ratio24h, tvl: Math.round(c.tvl), vol24: Math.round(c.vol24) })),
      config: {
        holder_share_pct: cfg.holderSharePct, reserve_share_pct: cfg.reserveSharePct, ops_share_pct: cfg.opsSharePct, buyback_share_pct: cfg.buybackSharePct, payout_interval_hours: cfg.payoutIntervalHours,
        min_payout_sol: cfg.minPayoutSol, max_pools: this.seats ?? seatCount(0), seat_sol: cfg.seatSol, min_seats: cfg.minSeats, max_seats: cfg.maxSeats, seat_weights: cfg.seatWeights, max_seat_pct: cfg.maxSeatPct, bins_below: cfg.binsBelow, bins_above: cfg.binsAbove,
        strategy: cfg.strategy, floor_pct_below_entry: cfg.floorPctBelowEntry, rotate_out_scans: cfg.rotateOutScans, scan_interval_sec: cfg.scanIntervalSec, tick_ms: cfg.tickMs,
      },
    });
    for (const b of this.bands.values()) { try { await ledger.savePool(b.row()); } catch (e) { log.warn(`savePool ${b.symbol}: ${e.message}`); } }
    if (now() - s.lastSnapshotAt >= cfg.snapshotIntervalSec * 1000) {
      s.lastSnapshotAt = now();
      await ledger.snapshot({ equity_sol: r6(freeSol + deployed), free_sol: r6(freeSol), deployed_sol: r6(deployed), pot_sol: r6(s.pot), paid_total_sol: r6(s.paidTotal), open_pools: this.openBands().length });
    }
    // forget closed bands once persisted so the map doesn't grow forever
    for (const [k, b] of this.bands) if (b.s.status === 'closed') this.bands.delete(k);
  }
}
