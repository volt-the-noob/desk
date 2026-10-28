import { parseUnits, formatUnits } from 'viem';
import { pub, evmAccount, ethBalance, tokenBalance, tokenDecimals, sendToken, send, ERC20 } from './chain.js';
import { USDG, swapEthToUsdg, swapUsdgToEth, ethUsd, quote } from './swap.js';
import { PonsTax } from './pons.js';
import { Holders, payHolders } from './holders.js';
import { cfg } from '../config.js';
import { ledger } from '../ledger.js';
import { log } from '../log.js';

const now = () => Date.now();
const iso = (t) => (t ? new Date(t).toISOString() : null);
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const r2 = (n) => Math.round(n * 100) / 100;
const DEAD = '0x000000000000000000000000000000000000dEaD';

/**
 * The Robinhood Chain desk.
 *
 * Revenue is the pons v2 creator tax on every trade of the token. It accrues on the bonding curve, the keeper claims it
 * and swaps it to USDG on the spot, so the pot is always held in the unit holders are paid in. Once a day the pot is
 * split: holders pro rata in USDG, OPS its share, and an optional slice buys the token back and burns it.
 *
 * The pot, the clock, the splits and the dust accrual match the Solana desk exactly; only the chain and the unit differ.
 */
export class EvmFund {
  constructor() {
    this.tax = new PonsTax(this);
    this.holders = new Holders();
    this.s = {
      status: 'running', pot: 0, incomeTotal: 0, paidTotal: 0, opsTotal: 0, reserveTotal: 0, unpaidOwed: 0,
      buybackTotal: 0, burnedTotal: 0, allocatedTotal: 0, holdersCount: null, eligibleSupply: null,
      equity: 0, startEquity: null, lastPayoutAt: 0, lastSnapshotAt: 0, lastHolderScanAt: 0,
    };
    this.lastEthUsd = null;
  }

  async ethUsd() { this.lastEthUsd = (await ethUsd()) ?? this.lastEthUsd; return this.lastEthUsd; }

  async boot() {
    const row = await ledger.loadState();
    if (row) {
      const s = this.s;
      s.status = row.status ?? 'running';
      for (const [k, col] of Object.entries({ pot: 'pot_sol', incomeTotal: 'income_total_sol', paidTotal: 'paid_total_sol', opsTotal: 'ops_total_sol', reserveTotal: 'reserve_total_sol', unpaidOwed: 'unpaid_owed_sol', allocatedTotal: 'allocated_total_sol', buybackTotal: 'buyback_total_sol', burnedTotal: 'burned_total_tokens' })) s[k] = Number(row[col] ?? 0);
      s.startEquity = row.start_equity_sol != null ? Number(row.start_equity_sol) : null;
      s.lastPayoutAt = row.last_payout_at ? Date.parse(row.last_payout_at) : 0;
    }
    if (!this.s.lastPayoutAt) this.s.lastPayoutAt = now();
    await this.tax.init().catch((e) => log.warn(`pons init deferred: ${e.shortMessage ?? e.message}`));
    const me = evmAccount().address;
    log.info(`desk "${cfg.deskName}" on Robinhood Chain · wallet ${me} · ${(await ethBalance(me)).toFixed(5)} ETH · ${(await tokenBalance(USDG, me)).toFixed(2)} USDG · dryRun=${cfg.dryRun}`);
    await ledger.event('boot', { detail: { chain: 'robinhood', dry_run: cfg.dryRun, wallet: me, token: cfg.evmTokenAddress || null } });
  }

  // ---------- pot ----------
  owedHolders() { return (cfg.holderSharePct / 100) * Math.max(this.s.pot, 0); }
  owedOps() { return (cfg.opsSharePct / 100) * Math.max(this.s.pot, 0); }
  owedBuyback() { return (cfg.buybackSharePct / 100) * Math.max(this.s.pot, 0); }

  /** Income is already in USDG (tax is swapped on claim). */
  async onIncome(usdg, tx, source) {
    this.s.pot += usdg;
    this.s.incomeTotal += usdg;
    log.info(`income +${usdg.toFixed(2)} USDG (${source}) → pot ${this.s.pot.toFixed(2)}`);
    await ledger.event('income', { solDelta: usdg, txs: tx ? [tx] : [], detail: { chain: 'robinhood', source, usdg: r2(usdg) } });
  }

  nextPayoutAt() { return this.s.lastPayoutAt + cfg.payoutIntervalHours * 3600e3; }
  payoutDue() { return now() >= this.nextPayoutAt() || (cfg.payoutThresholdSol > 0 && this.owedHolders() >= cfg.payoutThresholdSol); }

  /** Keep a little ETH for gas: if the wallet runs dry, sell a small amount of USDG back to ETH. */
  async topUpGas() {
    if (cfg.dryRun) return;
    const have = await ethBalance(evmAccount().address);
    if (have >= cfg.evmGasReserveEth) return;
    const px = await this.ethUsd();
    if (!px) return;
    const need = (cfg.evmGasReserveEth * 2 - have) * px;
    const usdg = await tokenBalance(USDG, evmAccount().address);
    if (usdg < need) { log.warn(`gas low (${have.toFixed(5)} ETH) and not enough USDG to top up`); return; }
    log.info(`gas low (${have.toFixed(5)} ETH): selling ${need.toFixed(2)} USDG for ETH`);
    await swapUsdgToEth(need);
  }

  // ---------- payouts ----------
  async payout() {
    const potBefore = this.s.pot;
    this.s.lastPayoutAt = now();
    if (potBefore <= 0.01) {
      log.warn(`payout clock: pot is ${potBefore.toFixed(2)} USDG, nothing to distribute`);
      await ledger.event('payout-skipped', { detail: { pot: r2(potBefore) } });
      return;
    }
    const holderUsdg = this.owedHolders(), opsUsdg = this.owedOps(), buybackUsdg = this.owedBuyback();
    const reserveUsdg = (cfg.reserveSharePct / 100) * potBefore;
    const me = evmAccount().address;
    const dec = await tokenDecimals(USDG);
    let available = cfg.dryRun ? potBefore : await tokenBalance(USDG, me);

    // ops leg
    let opsPaid = 0;
    if (opsUsdg > 0 && cfg.evmOpsWallet) {
      const pay = Math.min(opsUsdg, available);
      if (pay >= 0.01) {
        try { await sendToken(USDG, cfg.evmOpsWallet, parseUnits(pay.toFixed(dec), dec), 'ops-transfer'); opsPaid = pay; available -= pay; }
        catch (e) { log.error(`ops transfer failed, staying in pot: ${e.shortMessage ?? e.message}`); }
      }
    }

    // holders leg
    let res = { allocated: 0, paid: 0, walletsPaid: 0, txCount: 0, holders: 0 };
    if (holderUsdg > 0 && cfg.evmTokenAddress) {
      const snap = await this.holders.snapshot();
      this.s.holdersCount = snap.length;
      this.s.eligibleSupply = Number(snap.reduce((a, h) => a + h.raw, 0n)) / 1e18;
      res = await payHolders({ holders: snap, amountUsdg: holderUsdg, availableUsdg: available });
      available -= res.paid;
    }

    // buyback and burn
    let bb = { usdg: 0, burned: 0, tx: null };
    if (buybackUsdg > 0 && cfg.evmTokenAddress) {
      try { bb = await this.buybackAndBurn(Math.min(buybackUsdg, available)); available -= bb.usdg; }
      catch (e) { log.error(`buyback failed, share stays in the pot: ${e.shortMessage ?? e.message}`); }
    }

    this.s.pot -= res.allocated + opsPaid + reserveUsdg + bb.usdg;
    this.s.allocatedTotal += res.allocated;
    this.s.paidTotal += res.paid;
    this.s.opsTotal += opsPaid;
    this.s.reserveTotal += reserveUsdg;
    this.s.buybackTotal += bb.usdg;
    this.s.burnedTotal += bb.burned;
    this.s.unpaidOwed = cfg.dryRun ? Math.max(0, this.s.unpaidOwed + res.allocated - res.paid) : await ledger.unpaidTotal();
    await ledger.event('payout', { detail: {
      chain: 'robinhood', unit: 'USDG', pot_before: r2(potBefore), pot_after: r2(this.s.pot),
      holders_sol: r2(res.allocated), holders_paid_sol: r2(res.paid), ops_sol: r2(opsPaid), reserve_sol: r2(reserveUsdg),
      buyback_sol: r2(bb.usdg), burned_tokens: bb.burned, wallets: res.walletsPaid, holders: res.holders, tx_count: res.txCount,
    } });
  }

  /**
   * Buy the token back and burn it. Before graduation the only market is the pons bonding curve, which takes ETH,
   * so the desk sells USDG for ETH and buys on the curve; after graduation it routes through Uniswap
   * (USDG → WETH → token, since pons pools are WETH-paired).
   */
  async buybackAndBurn(usdg) {
    const out = { usdg: 0, burned: 0, tx: null };
    if (usdg < 1) return out;
    const dec = await tokenDecimals(USDG);
    const amountIn = parseUnits(usdg.toFixed(dec), dec);
    const { routeUsdgToToken, swapUsdgToToken, swapUsdgToEth } = await import('./swap.js');
    const graduated = this.tax.state.graduated ?? await pub.readContract({ address: this.tax.curve, abi: (await import('./pons.js')).CURVE_ABI, functionName: 'graduated' }).catch(() => true);

    if (!graduated) {
      const px = await this.ethUsd();
      const eth = px ? usdg / px : 0;
      if (cfg.dryRun) { log.info(`[dry-run] buyback (pre-graduation): ${usdg.toFixed(2)} USDG → ~${eth.toFixed(5)} ETH → curve buy, then burn`); return { usdg, burned: 0, tx: null }; }
      await swapUsdgToEth(usdg);
      const { parseEther } = await import('viem');
      const { CURVE_ABI } = await import('./pons.js');
      out.tx = await send({ address: this.tax.curve, abi: CURVE_ABI, functionName: 'buy', args: [0n, BigInt(Math.floor(Date.now() / 1000) + 600), evmAccount().address], value: parseEther(eth.toFixed(18)), label: 'buyback-on-curve' });
    } else {
      const { out: expect } = await routeUsdgToToken(cfg.evmTokenAddress, amountIn);
      const tokens = Number(formatUnits(expect, 18));
      if (cfg.dryRun) { log.info(`[dry-run] buyback ${usdg.toFixed(2)} USDG → ~${tokens.toFixed(0)} tokens, then burn`); return { usdg, burned: tokens, tx: null }; }
      out.tx = await swapUsdgToToken(usdg, cfg.evmTokenAddress);
    }
    const bal = await pub.readContract({ address: cfg.evmTokenAddress, abi: ERC20, functionName: 'balanceOf', args: [evmAccount().address] });
    if (bal > 0n) {
      await send({ address: cfg.evmTokenAddress, abi: ERC20, functionName: 'transfer', args: [DEAD, bal], label: 'burn' });
      out.burned = Number(formatUnits(bal, 18));
    }
    out.usdg = usdg;
    log.info(`buyback: ${usdg.toFixed(2)} USDG → burned ${out.burned.toFixed(0)} tokens`);
    return out;
  }

  // ---------- loop ----------
  async tick() {
    try { const row = await ledger.loadState(); if (row?.status && row.status !== this.s.status) { log.info(`status: ${this.s.status} → ${row.status}`); this.s.status = row.status; } } catch {}
    await this.topUpGas();
    if (this.s.status === 'running') { try { await this.tax.tick(); } catch (e) { log.error(`tax claim failed: ${e.shortMessage ?? e.message}`); } }
    if (this.payoutDue()) await this.payout();
    await this.mark();
  }

  async mark() {
    const me = evmAccount().address;
    const px = await this.ethUsd();
    const [eth, usdg] = await Promise.all([ethBalance(me), tokenBalance(USDG, me)]);
    const equity = usdg + eth * (px ?? 0);
    const s = this.s;
    s.equity = equity;
    if (s.startEquity == null) s.startEquity = r2(equity);
    if (cfg.evmTokenAddress && now() - s.lastHolderScanAt > 3600e3) {
      s.lastHolderScanAt = now();
      try { const snap = await this.holders.snapshot(); s.holdersCount = snap.length; s.eligibleSupply = Number(snap.reduce((a, h) => a + h.raw, 0n)) / 1e18; }
      catch (e) { log.warn(`holder refresh failed: ${e.shortMessage ?? e.message}`); }
    }
    await ledger.saveState({
      chain: 'robinhood', unit: 'USDG', wallet: me, holder_token_mint: cfg.evmTokenAddress || null, ops_wallet: cfg.evmOpsWallet || null,
      dry_run: cfg.dryRun, status: s.status, sol_usd: px, gas_sol: r6(eth), low_gas: eth < cfg.evmGasReserveEth,
      pot_sol: r2(s.pot), income_total_sol: r2(s.incomeTotal), profit_total_sol: r2(s.incomeTotal),
      allocated_total_sol: r2(s.allocatedTotal), paid_total_sol: r2(s.paidTotal), paid_total_usd: r2(s.paidTotal),
      ops_total_sol: r2(s.opsTotal), ops_total_usd: r2(s.opsTotal), reserve_total_sol: r2(s.reserveTotal), unpaid_owed_sol: r2(s.unpaidOwed),
      buyback_total_sol: r2(s.buybackTotal), buyback_total_usd: r2(s.buybackTotal), burned_total_tokens: s.burnedTotal,
      equity_sol: r2(equity), start_equity_sol: s.startEquity, free_sol: r2(usdg), deployed_sol: 0, open_pools: 0,
      holders_count: s.holdersCount, eligible_supply: s.eligibleSupply, pools_on: false,
      fee_claim: this.tax.view(),
      last_tick_at: iso(now()), last_payout_at: iso(s.lastPayoutAt), next_payout_at: iso(this.nextPayoutAt()),
      config: { chain: 'robinhood', unit: 'USDG', holder_share_pct: cfg.holderSharePct, reserve_share_pct: cfg.reserveSharePct, ops_share_pct: cfg.opsSharePct, buyback_share_pct: cfg.buybackSharePct, payout_interval_hours: cfg.payoutIntervalHours, min_payout_sol: cfg.evmMinPayoutUsdg },
    });
    if (now() - s.lastSnapshotAt >= cfg.snapshotIntervalSec * 1000) {
      s.lastSnapshotAt = now();
      await ledger.snapshot({ equity_sol: r2(equity), free_sol: r2(usdg), deployed_sol: 0, pot_sol: r2(s.pot), paid_total_sol: r2(s.paidTotal), open_pools: 0 });
    }
  }

  openBands() { return []; }
}
