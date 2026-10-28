import { parseAbi, formatEther } from 'viem';
import { pub, evmAccount, send, ethBalance } from './chain.js';
import { swapEthToUsdg } from './swap.js';
import { cfg } from '../config.js';
import { ledger } from '../ledger.js';
import { log } from '../log.js';

/**
 * pons v2 creator tax.
 *
 * Verified on-chain against live 2%-tax launches: every trade on the bonding curve takes `creatorTaxBps` of the quote
 * side and accrues it in the curve's `creatorTaxBalance()`, separate from the protocol's own 1% (`quoteFeeBalance`).
 * Accrued tax is swept into a shared FeeEscrow, where each recipient has a `credit(address)` they withdraw with
 * `claim()`. The keeper therefore checks both places and takes whatever is available.
 *
 * Tax arrives in the launch's quote asset (ETH for an ETH-paired launch). Holders are paid in USDG, so each claim is
 * swapped straight to USDG — the treasury never sits in ETH between a claim and a payout.
 */
export const CURVE_ABI = parseAbi([
  'function creatorTaxBps() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function isNativeQuote() view returns (bool)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function quoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeEscrow() view returns (address)',
  'function token() view returns (address)',
  'function deployer() view returns (address)',
  'function rescueFees()',
  'function buy(uint256 minTokensOut, uint256 deadline, address to) payable returns (uint256)',
  'function setCreatorFeeRecipient(address)',
]);
export const TOKEN_ABI = parseAbi(['function curve() view returns (address)', 'function deployer() view returns (address)']);
// verified on-chain: recipients read their own balance with balanceOf(address) and withdraw with claim()
export const ESCROW_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function claim()',
  'function claimToken(address)',
  'function balanceOfToken(address,address) view returns (uint256)',
]);

export class PonsTax {
  constructor(fund) {
    this.fund = fund;
    this.on = !!cfg.evmTokenAddress;
    this.lastCheck = 0; this.lastClaim = Date.now();
    this.state = { taxBps: null, pendingEth: 0, escrowEth: 0, graduated: null, progress: null };
    this.claimedEth = 0; this.claimedUsdg = 0;
  }

  async init() {
    if (!this.on || this.curve) return;
    this.curve = await pub.readContract({ address: cfg.evmTokenAddress, abi: TOKEN_ABI, functionName: 'curve' });
    const [bps, escrow, native] = await Promise.all([
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'creatorTaxBps' }),
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'feeEscrow' }).catch(() => null),
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'isNativeQuote' }).catch(() => true),
    ]);
    this.escrow = cfg.evmFeeEscrow || escrow;
    this.state.taxBps = Number(bps);
    this.nativeQuote = native;
    log.info(`pons tax: token ${cfg.evmTokenAddress} · curve ${this.curve} · ${Number(bps) / 100}% creator tax · escrow ${this.escrow} · quote ${native ? 'ETH' : 'token'}`);
  }

  /** What is claimable right now, from the curve and from the escrow credit. */
  async pending() {
    const me = evmAccount().address;
    const [onCurve, inEscrow, graduated, reserve, threshold] = await Promise.all([
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'creatorTaxBalance' }).catch(() => 0n),
      this.escrow ? pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: 'balanceOf', args: [me] }).catch(() => 0n) : 0n,
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'graduated' }).catch(() => null),
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'quoteReserve' }).catch(() => 0n),
      pub.readContract({ address: this.curve, abi: CURVE_ABI, functionName: 'graduationThreshold' }).catch(() => 0n),
    ]);
    this.state.pendingEth = Number(formatEther(onCurve));
    this.state.escrowEth = Number(formatEther(inEscrow));
    this.state.graduated = graduated;
    this.state.progress = threshold > 0n ? Number(reserve) / Number(threshold) : null;
    return { onCurve, inEscrow };
  }

  async tick() {
    if (!this.on || Date.now() - this.lastCheck < cfg.claimCheckSec * 1000) return;
    this.lastCheck = Date.now();
    await this.init();
    const { onCurve, inEscrow } = await this.pending();
    const px = (await this.fund.ethUsd?.()) ?? 0;
    const totalEth = this.state.escrowEth;   // only the escrow balance is withdrawable right now
    const due = totalEth >= cfg.evmClaimDustEth
      && (totalEth * px >= cfg.claimMinUsd || Date.now() - this.lastClaim >= cfg.claimIntervalSec * 1000);
    if (!due) return;

    const before = await ethBalance(evmAccount().address);
    const txs = [];
    // pons automation sweeps the curve into the escrow on its own; the desk only withdraws what is credited to it
    if (inEscrow > 0n) {
      try { txs.push(await send({ address: this.escrow, abi: ESCROW_ABI, functionName: 'claim', label: 'pons-claim-tax' })); }
      catch (e) { log.warn(`escrow claim failed: ${e.shortMessage ?? e.message}`); return; }
    } else { log.info(`tax accruing on the curve (${this.state.pendingEth.toFixed(6)} ETH), not yet swept to the escrow`); return; }
    this.lastClaim = Date.now();

    const claimed = cfg.dryRun ? totalEth : Math.max(0, (await ethBalance(evmAccount().address)) - before);
    if (claimed <= 0) return;
    this.claimedEth += claimed;
    log.info(`creator tax claimed: ${claimed.toFixed(6)} ETH`);
    await ledger.event('fee-claim', { txs, detail: { chain: 'robinhood', source: 'pons-creator-tax', eth: claimed, eth_usd: px, usd: Math.round(claimed * px * 100) / 100 } });

    // swap on claim: the pot is held in USDG so it cannot drift with ETH between claim and payout
    const keep = cfg.evmGasReserveEth;
    const toSwap = Math.max(0, claimed - Math.max(0, keep - before));
    if (toSwap > 0) {
      const usdg = await swapEthToUsdg(toSwap);
      this.claimedUsdg += usdg;
      await this.fund.onIncome(usdg, null, 'creator-tax');
    }
  }

  view() {
    return this.on ? {
      chain: 'robinhood', token: cfg.evmTokenAddress, curve: this.curve ?? null, tax_pct: this.state.taxBps != null ? this.state.taxBps / 100 : null,
      pending_eth: Math.round(this.state.pendingEth * 1e9) / 1e9, escrow_eth: Math.round(this.state.escrowEth * 1e9) / 1e9,
      graduated: this.state.graduated, graduation_progress: this.state.progress,
      claimed_eth: Math.round(this.claimedEth * 1e9) / 1e9, claimed_usdg: Math.round(this.claimedUsdg * 100) / 100,
      min_usd: cfg.claimMinUsd, next_by: new Date(this.lastClaim + cfg.claimIntervalSec * 1000).toISOString(),
    } : null;
  }
}
