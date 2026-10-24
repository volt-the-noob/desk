import { PublicKey } from '@solana/web3.js';
import { buildTransferTxs, sendTx, toLamports } from './chain.js';
import { snapshotHolders } from './holders.js';
import { ledger } from './ledger.js';
import { cfg } from './config.js';
import { log } from './log.js';

/**
 * One payout round:
 *   holders leg — allocate `holderSol` pro-rata into wallet_owed, then pay every wallet ≥ MIN_PAYOUT_SOL
 *   ops leg     — one transfer of `opsSol` to OPS_WALLET
 * `availableSol` caps what actually leaves the wallet this round (ops first, then holders).
 */
export async function runPayout({ holderToken, wallet, holderSol, opsSol, availableSol, potBefore }) {
  const out = { allocated: 0, paid: 0, opsPaid: 0, walletsPaid: 0, txCount: 0, holders: 0, payoutId: null };
  let budget = Math.max(0, availableSol);

  // --- ops leg ---
  if (opsSol > 0 && cfg.opsWallet) {
    const pay = Math.min(opsSol, budget);
    if (pay >= 0.001) {
      const [tx] = buildTransferTxs(wallet.publicKey, [{ to: new PublicKey(cfg.opsWallet), lamports: toLamports(pay) }], 1);
      try { await sendTx(tx, [wallet], 'ops-transfer'); out.opsPaid = pay; budget -= pay; out.txCount++; }
      catch (e) { log.error(`ops transfer failed, leaving in pot: ${e.message}`); }
    }
  }

  // --- holders leg ---
  if (holderSol > 0 && holderToken) {
    const holders = await snapshotHolders(holderToken, wallet.publicKey);
    out.holders = holders.length;
    if (holders.length) {
      const totalRaw = holders.reduce((s, h) => s + h.raw, 0n);
      const items = holders.map((h) => ({ wallet: h.wallet, sol: Number((BigInt(toLamports(holderSol)) * h.raw) / totalRaw) / 1e9 })).filter((it) => it.sol > 0);
      out.allocated = items.reduce((s, it) => s + it.sol, 0);

      if (cfg.dryRun) {
        const sim = items.filter((it) => it.sol >= cfg.minPayoutSol);
        out.paid = sim.reduce((s, it) => s + it.sol, 0);
        out.walletsPaid = sim.length;
        out.txCount += Math.ceil(sim.length / cfg.transfersPerTx);
        log.info(`[dry-run] would allocate ${out.allocated.toFixed(6)} SOL to ${items.length} wallets and pay ${out.paid.toFixed(6)} SOL to ${sim.length}`);
        out.payoutId = await ledger.recordPayout({ total_sol: out.paid, ops_sol: out.opsPaid, wallets: sim.length, tx_count: out.txCount, dry_run: true, pot_before: potBefore, holders_snapshot: holders.length }, sim.slice(0, 200).map((it) => ({ ...it, tx: null })));
        return out;
      }

      await ledger.accrueOwed(items);
      const payable = await ledger.payable(cfg.minPayoutSol);
      const toPay = [];
      for (const row of payable) { const sol = Number(row.owed_sol); if (sol > budget) break; toPay.push({ wallet: row.wallet, sol }); budget -= sol; }
      const txs = buildTransferTxs(wallet.publicKey, toPay.map((p) => ({ to: new PublicKey(p.wallet), lamports: toLamports(p.sol) })), cfg.transfersPerTx);
      const paidItems = [];
      for (let i = 0; i < txs.length; i++) {
        const batch = toPay.slice(i * cfg.transfersPerTx, (i + 1) * cfg.transfersPerTx);
        try {
          const sig = await sendTx(txs[i], [wallet], `payout-batch-${i + 1}/${txs.length}`);
          for (const b of batch) { paidItems.push({ ...b, tx: sig }); out.paid += b.sol; }
          await ledger.markPaid(batch);
        } catch (e) { log.error(`payout batch ${i + 1} failed, those wallets stay accrued: ${e.message}`); }
      }
      out.walletsPaid = paidItems.length;
      out.txCount += txs.length;
      out.payoutId = await ledger.recordPayout({ total_sol: out.paid, ops_sol: out.opsPaid, wallets: paidItems.length, tx_count: out.txCount, dry_run: false, pot_before: potBefore, holders_snapshot: holders.length }, paidItems);
    }
  } else if (holderSol > 0) {
    log.warn('HOLDER_TOKEN_MINT not set — holder share stays in the pot');
  }

  log.info(`payout: holders ${out.paid.toFixed(4)} SOL to ${out.walletsPaid} wallets, ops ${out.opsPaid.toFixed(4)} SOL, ${out.txCount} tx${cfg.dryRun ? ' (dry-run)' : ''}`);
  return out;
}
