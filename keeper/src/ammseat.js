import { cfg } from './config.js';
import { log } from './log.js';

const now = () => Date.now();
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const iso = (t) => (t ? new Date(t).toISOString() : null);

/**
 * A seat in a PumpSwap pool (full range). No band to re-centre: fees compound into the pool, so the seat's value is
 * simply its share of the reserves. Fees earned are measured from the pool's own growth (√(base·quote) per LP token),
 * the rest of the change is price. Same exits as a Meteora seat: floor, trailing stop (meme), max hold, filters.
 * Paper mode holds a virtual LP amount against the live pool, so its value is the real pool's, fees and moves included.
 */
export class AmmSeat {
  constructor(fund, pool, meta = {}) {
    this.fund = fund; this.pool = pool; this.venue = 'pumpswap';
    this.address = pool.address.toBase58();
    this.symbol = meta.symbol ?? this.address.slice(0, 6);
    this.sleeve = meta.sleeve ?? 'calm';
    this.opts = this.sleeve === 'meme'
      ? { floorPct: cfg.memeFloorPct, trailPct: cfg.memeTrailPct, maxHoldHours: cfg.memeMaxHoldHours }
      : { floorPct: cfg.floorPctBelowEntry, trailPct: 0, maxHoldHours: cfg.maxHoldHours };
    this.s = { status: 'open', capitalSol: 0, feesSol: 0, bandPnlSol: 0, entryPrice: null, lastPrice: null, peak: null, lp: '0', kEntry: null,
      openedAt: now(), closedAt: null, exitReason: null, missScans: 0, lastScore: meta.score ?? null, lastRatio1h: meta.ratio1h ?? 0, position: null };
  }

  tag() { return `[${this.symbol}·pumpswap]`; }
  floor() { return this.opts.floorPct > 0 && this.s.entryPrice ? this.s.entryPrice * (1 - this.opts.floorPct / 100) : 0; }

  /** SOL value of our LP share right now (at the pool's own price) and fees earned since entry. */
  async mark() {
    const st = await this.pool.state(this.fund.wallet.publicKey);
    const lp = BigInt(this.s.lp), share = Number(lp) / Number(st.lpSupply);
    const value = share * (Number(st.quote) / 1e9) * 2;
    const growth = this.s.kEntry ? st.kPerLp / this.s.kEntry : 1;   // fees compound into the pool: k per LP grows
    return { value, fees: Math.max(0, value * (1 - 1 / growth)), price: st.price };   // pump.fun takes protocol/creator fees from reserves, so clamp
  }
  async value() { return (await this.mark()).value; }
  async valueCached() { try { const m = await this.mark(); this.s.valueSol = m.value; this.s.feesSol = r6(m.fees); return m.value; } catch { return this.s.valueSol ?? null; } }

  async enter(budgetSol) {
    const quoteLamports = BigInt(Math.floor((budgetSol / 2) * 1e9));
    const d = await this.pool.deposit(this.fund.wallet, quoteLamports);
    this.s.lp = d.lp.toString(); this.s.kEntry = d.kPerLp;
    this.s.capitalSol = budgetSol; this.s.openedAt = now();
    const m = await this.mark();
    this.s.entryPrice = m.price; this.s.peak = m.price; this.s.lastPrice = m.price;
    if (this.fund.virt) this.fund.virt.sol -= budgetSol;
    log.info(`${this.tag()} enter: ${budgetSol.toFixed(3)} SOL → ${d.lp} LP (value ${m.value.toFixed(4)} SOL)`);
    await this.fund.event('pool-enter', this, { price: m.price, txs: d.sigs, detail: { venue: 'pumpswap', capital_sol: r6(budgetSol), lp: this.s.lp, value_sol: r6(m.value) } });
  }

  async tick() {
    if (this.s.status !== 'open') return;
    const m = await this.mark();
    this.s.lastPrice = m.price; this.s.feesSol = r6(m.fees);
    const floor = this.floor();
    if (floor > 0 && m.price < floor) return this.exit('floor', { floor, price: m.price });
    this.s.peak = Math.max(this.s.peak ?? m.price, m.price);
    if (this.opts.trailPct > 0 && m.price < this.s.peak * (1 - this.opts.trailPct / 100)) return this.exit('trailing-stop', { peak: this.s.peak, price: m.price });
    if (this.opts.maxHoldHours > 0 && now() - this.s.openedAt > this.opts.maxHoldHours * 3600e3) return this.exit('max-hold');
  }

  async exit(reason, extra = {}) {
    const m = await this.mark();
    const out = await this.pool.withdrawAndSell(this.fund.wallet, BigInt(this.s.lp));
    const pnl = out.sol - this.s.capitalSol, fees = Math.max(0, Math.min(m.fees, out.sol)), bandPnl = pnl - fees;
    if (this.fund.virt) this.fund.virt.sol += out.sol;
    this.s.feesSol = 0; // booked below as realised
    await this.fund.book(reason === 'floor' ? 'floor' : 'pool-exit', this, { solDelta: pnl, fees, bandPnl, price: m.price, txs: out.sigs, detail: { venue: 'pumpswap', reason, sol_out: r6(out.sol), ...extra } });
    this.s.status = 'closed'; this.s.closedAt = now(); this.s.exitReason = reason; this.s.lp = '0';
    log.warn(`${this.tag()} EXIT (${reason}): ${out.sol.toFixed(4)} SOL back on ${this.s.capitalSol.toFixed(3)} (fees ${fees.toFixed(4)}, price ${bandPnl >= 0 ? '+' : ''}${bandPnl.toFixed(4)})`);
  }

  row() {
    const s = this.s;
    return { pool_address: this.address, token_mint: this.pool.mintX.toBase58(), symbol: this.symbol, status: s.status, venue: 'pumpswap', sleeve: this.sleeve,
      capital_sol: r6(s.capitalSol), sol_leg: 0, fees_sol: r6(s.feesSol), band_pnl_sol: r6(s.bandPnlSol), entry_price: s.entryPrice, last_price: s.lastPrice,
      floor_price: this.floor() || null, last_score: s.lastScore, miss_scans: s.missScans, peak_price: s.peak, lp_amount: s.lp, k_entry: s.kEntry,
      value_sol: s.valueSol != null ? r6(s.valueSol) : null,
      unrealised_sol: s.valueSol != null ? r6(s.valueSol - s.capitalSol) : null,
      total_pnl_sol: s.valueSol != null ? r6(s.feesSol + s.valueSol - s.capitalSol) : r6(s.feesSol),
      opened_at: iso(s.openedAt), closed_at: iso(s.closedAt), exit_reason: s.exitReason, updated_at: iso(now()) };
  }

  static hydrate(fund, pool, row) {
    const b = new AmmSeat(fund, pool, { symbol: row.symbol, score: row.last_score, sleeve: row.sleeve ?? 'calm' });
    Object.assign(b.s, { status: row.status, capitalSol: Number(row.capital_sol ?? 0), feesSol: Number(row.fees_sol ?? 0), bandPnlSol: Number(row.band_pnl_sol ?? 0),
      entryPrice: row.entry_price != null ? Number(row.entry_price) : null, peak: row.peak_price != null ? Number(row.peak_price) : null, lp: row.lp_amount ?? '0',
      kEntry: row.k_entry != null ? Number(row.k_entry) : null, missScans: row.miss_scans ?? 0, openedAt: row.opened_at ? Date.parse(row.opened_at) : now() });
    return b;
  }
}
