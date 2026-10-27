import { toLamports, unwrapWsol } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

const now = () => Date.now();
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** One pool, one band. All money results are reported to the fund via fund.book(). */
export class Band {
  constructor(fund, pool, meta = {}) {
    this.fund = fund;
    this.pool = pool;
    this.wallet = fund.wallet;
    this.address = pool.address.toBase58();
    this.symbol = meta.symbol ?? this.address.slice(0, 6);
    this.sleeve = meta.sleeve ?? 'calm';
    // exits: meme seats get a trailing stop, a maximum hold and their own floor; calm seats keep the desk-wide floor
    this.opts = this.sleeve === 'meme'
      ? { floorPct: cfg.memeFloorPct, trailPct: cfg.memeTrailPct, maxHoldHours: cfg.memeMaxHoldHours }
      : { floorPct: cfg.floorPctBelowEntry, trailPct: 0, maxHoldHours: cfg.maxHoldHours };
    this.s = {
      status: 'open',
      position: null,            // { pubkey, lower, upper, costSol, xIn, yIn, priceIn, openedAt }
      entryPrice: null,
      capitalSol: 0,             // SOL budget this band was given at entry
      solLeg: 0,                 // SOL currently belonging to this band but sitting in the wallet (between bands)
      feesSol: 0, bandPnlSol: 0,
      openedAt: now(), closedAt: null, exitReason: null,
      missScans: 0, lastScore: meta.score ?? null, lastPrice: null,
      lastHarvestAt: 0, lastRebalanceAt: 0,
    };
    this.oorTicks = 0;
  }

  tag() { return `[${this.symbol}]`; }

  floor() {
    return this.opts.floorPct > 0 && this.s.entryPrice ? this.s.entryPrice * (1 - this.opts.floorPct / 100) : 0;
  }

  /** Uniform view over the on-chain position or the dry-run virtual one. */
  async view(price) {
    if (!cfg.dryRun) {
      const p = await this.pool.position(this.wallet.publicKey);
      if (!p) { if (this.s.position) { log.warn(`${this.tag()} position vanished on-chain; clearing`); this.s.position = null; } return null; }
      const v = this.pool.positionValue(p, price);
      if (!this.s.position || this.s.position.pubkey !== p.publicKey.toBase58()) {
        this.s.position = { pubkey: p.publicKey.toBase58(), lower: v.lower, upper: v.upper, costSol: v.valueSol, xIn: v.x, yIn: v.y, priceIn: price, openedAt: now() };
        if (this.s.entryPrice == null) this.s.entryPrice = price;
        log.warn(`${this.tag()} adopted position ${this.s.position.pubkey} at cost ${v.valueSol.toFixed(4)} SOL`);
      }
      return { ...v, raw: p };
    }
    const sp = this.s.position;
    if (!sp) return null;
    return { x: sp.xIn, y: sp.yIn, feeX: 0, feeY: 0, lower: sp.lower, upper: sp.upper, valueSol: sp.yIn + sp.xIn * price, feesSol: 0, raw: null };
  }

  /** Current SOL value of everything this band holds (position + unclaimed fees + loose inventory of its token). */
  async value() {
    const { price } = await this.pool.price();
    const pos = await this.view(price);
    const { xUi } = await this.fund.balances(this.pool);
    return (pos ? pos.valueSol + pos.feesSol : 0) + xUi * price;
  }

  // ---------- lifecycle ----------
  async enter(budgetSol) {
    const { binId, price } = await this.pool.price();
    this.s.entryPrice = price;
    this.s.capitalSol = budgetSol;
    this.s.solLeg = budgetSol;
    this.s.openedAt = now();
    await this.openBand(price, binId, budgetSol, 'pool-enter');
  }

  async tick() {
    if (this.s.status !== 'open') return;
    const { binId, price } = await this.pool.price();
    this.s.lastPrice = price;
    const pos = await this.view(price);
    const floor = this.floor();
    if (floor > 0 && price < floor) return this.exit('floor', { floor, price });
    this.s.peak = Math.max(this.s.peak ?? this.s.entryPrice ?? price, price);
    if (this.opts.trailPct > 0 && price < this.s.peak * (1 - this.opts.trailPct / 100)) return this.exit('trailing-stop', { peak: this.s.peak, price });
    if (this.opts.maxHoldHours > 0 && now() - this.s.openedAt > this.opts.maxHoldHours * 3600e3) return this.exit('max-hold');
    if (!pos) {
      // nothing deployed (e.g. a previous open failed); try again with this band's loose inventory + its capital
      return this.openBand(price, binId, this.s.capitalSol, 'pool-enter');
    }
    const inRange = binId >= pos.lower && binId <= pos.upper;
    this.oorTicks = inRange ? 0 : this.oorTicks + 1;
    const cooled = now() - this.s.lastRebalanceAt >= cfg.rebalanceCooldownSec * 1000;
    if (!inRange && this.oorTicks >= cfg.outOfRangeTicks && cooled) {
      await this.closeAndBook(pos, price, 'rebalance', { reason: 'out of range', active: binId });
      await this.openBand(price, binId, null, 'rebalance');
    } else if (cfg.dryRun && now() - this.s.lastHarvestAt >= cfg.harvestIntervalSec * 1000) {
      await this.paperHarvest(inRange);
    } else if (now() - this.s.lastHarvestAt >= cfg.harvestIntervalSec * 1000 && pos.feesSol >= cfg.harvestMinSol) {
      await this.harvest(pos, price);
    }
  }

  /** Close the band, sell the token if configured, hand the SOL back to the fund. */
  async exit(reason, extra = {}) {
    const { binId, price } = await this.pool.price();
    const pos = await this.view(price);
    if (pos) await this.closeAndBook(pos, price, reason === 'floor' ? 'floor' : 'pool-exit', { reason, active: binId, ...extra });
    const { xRaw, xUi } = await this.fund.balances(this.pool);
    let sold = 0; const txs = [];
    if (xRaw > 0n && (cfg.exitSellInventory || reason === 'floor')) {
      const r = await this.fund.swap(this.pool, { inRaw: xRaw, swapForY: true });
      txs.push(...r.sigs);
      sold = Number(r.outRaw) / 1e9;
      const slip = sold - this.pool.xUi(r.inRaw) * price; // realised vs mark
      await this.fund.book('exit-sell', this, { solDelta: slip, bandPnl: slip, price, txs, detail: { reason, sold_x: xUi, sold_sol: r6(sold) } });
    }
    this.s.status = 'closed';
    this.s.closedAt = now();
    this.s.exitReason = reason;
    log.warn(`${this.tag()} EXIT (${reason}): fees ${this.s.feesSol.toFixed(4)} band ${this.s.bandPnlSol >= 0 ? '+' : ''}${this.s.bandPnlSol.toFixed(4)} SOL on ${this.s.capitalSol.toFixed(2)} SOL capital`);
    if (!cfg.dryRun) await unwrapWsol(this.wallet).catch(() => {});
  }

  // ---------- actions ----------
  async openBand(price, binId, budgetSol, kind) {
    const { freeSol, xRaw, xUi } = await this.fund.balances(this.pool);
    const xValue = xUi * price;
    // deploy this band's own SOL leg, never more than the wallet can spare after gas + what's owed to holders/ops
    let ySol = Math.max(0, Math.min(this.s.solLeg, freeSol - this.fund.holdSol()));
    let xRawDep = xRaw, xUiDep = xUi;
    if (ySol < 0.01 && xRawDep === 0n) { log.warn(`${this.tag()} nothing to deploy (free ${freeSol.toFixed(3)} SOL)`); return; }

    const wantSplit = kind === 'pool-enter' ? cfg.entryMode === 'balanced' : cfg.rebalanceMode === 'balanced';
    const txs = [];
    if (wantSplit) {
      const total = ySol + xValue;
      const diff = (cfg.balancedXPct / 100) * total - xValue;
      if (diff > 0.01 && ySol > 0.02) {
        const spend = Math.min(diff, ySol - 0.005);
        const r = await this.fund.swap(this.pool, { inRaw: BigInt(toLamports(spend)), swapForY: false });
        txs.push(...r.sigs);
        xRawDep += r.outRaw; xUiDep = this.pool.xUi(xRawDep); ySol -= Number(r.inRaw) / 1e9; this.s.solLeg -= Number(r.inRaw) / 1e9;
      } else if (diff < -0.01) {
        const r = await this.fund.swap(this.pool, { inRaw: this.pool.xRaw(Math.min(-diff / price, xUiDep)), swapForY: true });
        txs.push(...r.sigs);
        xRawDep -= r.inRaw; xUiDep = this.pool.xUi(xRawDep); ySol += Number(r.outRaw) / 1e9; this.s.solLeg += Number(r.outRaw) / 1e9;
      }
    }

    const yLamports = BigInt(toLamports(Math.max(0, ySol)));
    const r = await this.pool.open(this.wallet, { xRaw: xRawDep, yLamports, activeId: binId });
    txs.push(...r.sigs);
    this.fund.onDeposit(this.pool, yLamports, xRawDep);
    this.s.solLeg -= Number(yLamports) / 1e9;
    const cost = Number(yLamports) / 1e9 + xUiDep * price;
    this.s.position = { pubkey: r.positionPubkey.toBase58(), lower: r.minBinId, upper: r.maxBinId, costSol: cost, xIn: xUiDep, yIn: Number(yLamports) / 1e9, priceIn: price, openedAt: now() };
    this.s.lastRebalanceAt = now();
    this.oorTicks = 0;
    log.info(`${this.tag()} ${kind}: band [${r.minBinId}, ${r.maxBinId}] active ${binId} price ${price.toExponential(3)} cost ${cost.toFixed(4)} SOL`);
    await this.fund.event(kind === 'pool-enter' ? 'pool-enter' : 'rebalance-open', this, { price, txs, detail: { lower: r.minBinId, upper: r.maxBinId, active: binId, cost_sol: r6(cost), x_in: xUiDep, y_in: Number(yLamports) / 1e9, capital_sol: r6(this.s.capitalSol) } });
  }

  async closeAndBook(pos, price, kind, extra = {}) {
    const sp = this.s.position;
    const txs = pos.raw ? await this.pool.close(this.wallet, pos.raw) : [];
    const bandPnl = pos.y + pos.x * price - (sp?.costSol ?? pos.valueSol);
    let fees = pos.feeY + pos.feeX * price;
    this.fund.onWithdraw(this.pool, pos.y + pos.feeY, this.pool.xRaw(pos.x + pos.feeX));
    this.s.solLeg += pos.y; // principal comes back to the band; fees go to the pot
    if (!cfg.dryRun && cfg.sellFeeX && pos.feeX * price >= cfg.minSellXSol) {
      const r = await this.fund.swap(this.pool, { inRaw: this.pool.xRaw(pos.feeX), swapForY: true });
      txs.push(...r.sigs);
      fees = pos.feeY + Number(r.outRaw) / 1e9;
    }
    this.s.position = null;
    this.s.lastHarvestAt = now();
    await this.fund.book(kind, this, { solDelta: bandPnl + fees, bandPnl, fees, price, txs, detail: { x_out: pos.x, y_out: pos.y, cost_sol: sp?.costSol, lower: pos.lower, upper: pos.upper, ...extra } });
    if (!cfg.dryRun) await unwrapWsol(this.wallet).catch(() => {});
  }

  /** Dry run: estimate the fees a real band would have earned since the last harvest, from the pool's live 1h fee/TVL. */
  async paperHarvest(inRange) {
    const dt = (now() - (this.s.lastHarvestAt || this.s.openedAt)) / 3600e3;
    this.s.lastHarvestAt = now();
    const r1 = Number(this.s.lastRatio1h ?? 0);
    if (!inRange || r1 <= 0) return;
    const fees = this.s.capitalSol * (r1 / 100) * Math.min(dt, 1) * cfg.dryRunFeeCapture;
    if (fees <= 0) return;
    this.fund.onPaperFees(fees);
    await this.fund.book('harvest', this, { solDelta: fees, fees, detail: { estimated: true, fee_tvl_1h: r1 } });
  }

  async harvest(pos, price) {
    if (!pos.raw) return;
    const txs = await this.pool.claimFees(this.wallet, pos.raw);
    let fees = pos.feeY + pos.feeX * price;
    if (cfg.sellFeeX && pos.feeX * price >= cfg.minSellXSol) {
      const r = await this.fund.swap(this.pool, { inRaw: this.pool.xRaw(pos.feeX), swapForY: true });
      txs.push(...r.sigs);
      fees = pos.feeY + Number(r.outRaw) / 1e9;
    }
    this.s.lastHarvestAt = now();
    await this.fund.book('harvest', this, { solDelta: fees, fees, price, txs, detail: { fee_y_sol: r6(pos.feeY), fee_x: pos.feeX } });
    if (!cfg.dryRun) await unwrapWsol(this.wallet).catch(() => {});
  }

  // ---------- persistence ----------
  row() {
    const s = this.s;
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      pool_address: this.address, token_mint: this.pool.mintX.toBase58(), symbol: this.symbol, status: s.status,
      capital_sol: r6(s.capitalSol), sol_leg: r6(s.solLeg), fees_sol: r6(s.feesSol), band_pnl_sol: r6(s.bandPnlSol), entry_price: s.entryPrice, last_price: s.lastPrice,
      floor_price: this.floor() || null, last_score: s.lastScore, miss_scans: s.missScans,
      position_pubkey: s.position?.pubkey ?? null, position_lower: s.position?.lower ?? null, position_upper: s.position?.upper ?? null,
      position_cost_sol: s.position?.costSol ?? null, position_x_in: s.position?.xIn ?? null, position_y_in: s.position?.yIn ?? null, position_price_in: s.position?.priceIn ?? null,
      opened_at: iso(s.openedAt), closed_at: iso(s.closedAt), exit_reason: s.exitReason, bin_step: this.pool.binStep, updated_at: iso(now()), sleeve: this.sleeve, peak_price: s.peak ?? null, venue: 'dlmm',
    };
  }

  static hydrate(fund, pool, row) {
    const b = new Band(fund, pool, { symbol: row.symbol, score: row.last_score, sleeve: row.sleeve ?? 'calm' });
    const s = b.s;
    s.status = row.status; s.capitalSol = Number(row.capital_sol ?? 0); s.solLeg = Number(row.sol_leg ?? 0); s.feesSol = Number(row.fees_sol ?? 0); s.bandPnlSol = Number(row.band_pnl_sol ?? 0);
    s.entryPrice = row.entry_price != null ? Number(row.entry_price) : null; s.missScans = row.miss_scans ?? 0;
    s.openedAt = row.opened_at ? Date.parse(row.opened_at) : now();
    if (row.peak_price != null) s.peak = Number(row.peak_price);
    if (row.position_pubkey) {
      s.position = { pubkey: row.position_pubkey, lower: row.position_lower, upper: row.position_upper, costSol: Number(row.position_cost_sol), xIn: Number(row.position_x_in), yIn: Number(row.position_y_in), priceIn: Number(row.position_price_in), openedAt: s.openedAt };
    }
    return b;
  }
}
