import { PublicKey } from '@solana/web3.js';
import { buildTransferTxs, sendTx, solBalance, toLamports, loadKeypair } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

/**
 * Creator-fee income. Pump.fun fee sharing sends the treasury's share (85%) of the creator fee to INCOME_WALLET.
 * Every INCOME_SWEEP_SEC the keeper moves that SOL into the desk wallet and books it to the pot as revenue,
 * so it is split on the payout clock like everything else. Kept separate from the desk wallet so that
 * capital you deposit into the desk is never mistaken for income.
 */
export class Income {
  constructor(fund) {
    this.fund = fund;
    this.wallet = cfg.incomeWalletSecret ? loadKeypair(cfg.incomeWalletSecret) : null;
    this.lastAt = 0;
    if (this.wallet) log.info(`income wallet ${this.wallet.publicKey.toBase58()} (creator-fee share) → swept to the desk every ${cfg.incomeSweepSec}s`);
  }

  async sweep() {
    if (!this.wallet || Date.now() - this.lastAt < cfg.incomeSweepSec * 1000) return;
    this.lastAt = Date.now();
    const bal = await solBalance(this.wallet.publicKey);
    const amount = bal - cfg.incomeKeepSol;
    if (amount < cfg.incomeMinSweepSol) return;
    const [tx] = buildTransferTxs(this.wallet.publicKey, [{ to: this.fund.wallet.publicKey, lamports: toLamports(amount) }], 1);
    const sig = await sendTx(tx, [this.wallet], 'income-sweep');
    this.fund.onIncome(amount, sig, 'creator-fee');
  }
}
