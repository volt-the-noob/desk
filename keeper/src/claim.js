import { createRequire } from 'node:module';
import { PublicKey, Transaction } from '@solana/web3.js';
import { connection, sendTx, solUsd } from './chain.js';
import { cfg } from './config.js';
import { ledger } from './ledger.js';
import { log } from './log.js';

// pump.fun's SDK: the ESM build has a broken anchor import (same as Meteora's), the CJS build is fine
const require = createRequire(import.meta.url);
const Pump = require('@pump-fun/pump-sdk');

/**
 * Creator-fee auto-claim (pump.fun fee sharing).
 *
 * With fee sharing on, the coin's creator fees pile up in a vault owned by its sharing config. Distributing them is
 * permissionless: one transaction pays every shareholder its share. Every CLAIM_CHECK_SEC the keeper reads how much is
 * waiting and distributes when it reaches CLAIM_MIN_USD, or when CLAIM_INTERVAL_SEC has passed since the last claim
 * (above dust), whichever comes first. The desk wallet pays the transaction fee. If the desk wallet is one of the
 * shareholders, its exact share is booked into the pot here; a separate income wallet is swept by income.js instead.
 */
export class FeeClaimer {
  constructor(fund) {
    this.fund = fund;
    this.on = cfg.claimEnabled && !!cfg.holderTokenMint;
    this.mint = this.on ? new PublicKey(cfg.holderTokenMint) : null;
    this.sdk = this.on ? new Pump.OnlinePumpSdk(connection) : null;
    this.lastCheck = 0;
    this.lastClaim = Date.now();
    this.pending = { sol: 0, usd: 0, canDistribute: false };
    this.deskBps = null;
    if (this.on) log.info(`creator-fee auto-claim on: check every ${cfg.claimCheckSec}s, distribute at $${cfg.claimMinUsd} or every ${cfg.claimIntervalSec}s`);
  }

  /** The desk wallet's cut of the creator fee, from the on-chain sharing config (null until the config exists). */
  async deskShareBps() {
    const info = await connection.getAccountInfo(Pump.feeSharingConfigPda(this.mint));
    if (!info) return null;
    const conf = Pump.PUMP_SDK.decodeSharingConfig(info);
    const me = this.fund.wallet.publicKey.toBase58();
    this.shareholders = conf.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
    return conf.shareholders.filter((s) => s.address.toBase58() === me).reduce((a, s) => a + s.shareBps, 0);
  }

  async tick() {
    if (!this.on || Date.now() - this.lastCheck < cfg.claimCheckSec * 1000) return;
    this.lastCheck = Date.now();
    const r = await this.sdk.getMinimumDistributableFee(this.mint);   // read-only simulation; the SDK uses its own funded signer
    const sol = Number(r.distributableFees.toString()) / 1e9;
    const px = (await solUsd()) ?? 0;
    this.pending = { sol, usd: sol * px, canDistribute: !!r.canDistribute };
    const due = r.canDistribute && sol >= cfg.claimDustSol && (sol * px >= cfg.claimMinUsd || Date.now() - this.lastClaim >= cfg.claimIntervalSec * 1000);
    if (!due) return;
    if (this.deskBps == null) this.deskBps = await this.deskShareBps();
    const { instructions } = await this.sdk.buildDistributeCreatorFeesInstructions(this.mint, { payer: this.fund.wallet.publicKey });
    const tx = new Transaction().add(...instructions);
    const sig = await sendTx(tx, [this.fund.wallet], 'distribute-creator-fees');
    this.lastClaim = Date.now();
    const deskSol = sol * (this.deskBps ?? 0) / 1e4;
    log.info(`creator fees distributed: ${sol.toFixed(4)} SOL ($${(sol * px).toFixed(0)}) to ${this.shareholders?.length ?? '?'} shareholders · desk share ${deskSol.toFixed(4)} SOL`);
    await ledger.event('fee-claim', { txs: [sig], detail: { sol, usd: Math.round(sol * px * 100) / 100, desk_sol: deskSol, desk_bps: this.deskBps, shareholders: this.shareholders } });
    if (deskSol > 0) await this.fund.onIncome(deskSol, sig, 'creator-fee');
  }

  view() { return this.on ? { pending_sol: Math.round(this.pending.sol * 1e6) / 1e6, pending_usd: Math.round(this.pending.usd * 100) / 100, can_distribute: this.pending.canDistribute, desk_bps: this.deskBps, next_by: new Date(this.lastClaim + cfg.claimIntervalSec * 1000).toISOString(), min_usd: cfg.claimMinUsd } : null; }
}
