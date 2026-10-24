import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram, LAMPORTS_PER_SOL,
  Transaction, SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createCloseAccountInstruction, NATIVE_MINT,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { cfg } from './config.js';
import { log } from './log.js';

export const connection = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });

export function loadWallet() {
  const s = cfg.walletSecret;
  if (!s) throw new Error('WALLET_SECRET not set');
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

export const toSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
export const toLamports = (sol) => Math.floor(sol * LAMPORTS_PER_SOL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withPriorityFee(tx) {
  const hasPrice = tx.instructions.some(
    (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3, // SetComputeUnitPrice
  );
  if (!hasPrice && cfg.priorityFeeMicroLamports > 0) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports }));
  }
  return tx;
}

/**
 * Sign + send a legacy Transaction with a fresh blockhash, priority fee, and retries.
 * In DRY_RUN this logs and returns a fake signature.
 */
export async function sendTx(tx, signers, label = 'tx') {
  if (cfg.dryRun) {
    log.info(`[dry-run] would send ${label} (${tx.instructions.length} ix)`);
    return `dry-run-${label}-${Date.now()}`;
  }
  withPriorityFee(tx);
  let lastErr;
  for (let attempt = 1; attempt <= cfg.txRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.signatures = [];
      tx.sign(...signers);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(conf.value.err)}`);
      log.info(`${label} confirmed ${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      log.warn(`${label} attempt ${attempt}/${cfg.txRetries} failed: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

export async function sendAll(txs, signers, label) {
  const sigs = [];
  for (let i = 0; i < txs.length; i++) sigs.push(await sendTx(txs[i], signers, `${label}#${i + 1}`));
  return sigs;
}

export async function solBalance(pubkey) {
  return toSol(await connection.getBalance(pubkey, 'confirmed'));
}

/** Raw token balance (bigint) of `owner`'s ATA for `mint`, under `programId`. */
export async function tokenBalanceRaw(owner, mint, programId = TOKEN_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
  try {
    const acc = await getAccount(connection, ata, 'confirmed', programId);
    return acc.amount;
  } catch {
    return 0n;
  }
}

/** Close a stray WSOL ATA so the lamports come back as native SOL. */
export async function unwrapWsol(wallet) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  try { await getAccount(connection, ata); } catch { return null; } // no WSOL account → nothing to do
  const tx = new Transaction().add(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey));
  return sendTx(tx, [wallet], 'unwrap-wsol');
}

/** Build batched SOL transfer txs: [{to: PublicKey, lamports: number}] → Transaction[] */
export function buildTransferTxs(from, items, perTx) {
  const txs = [];
  for (let i = 0; i < items.length; i += perTx) {
    const tx = new Transaction();
    for (const it of items.slice(i, i + perTx)) {
      tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: it.to, lamports: it.lamports }));
    }
    txs.push(tx);
  }
  return txs;
}

export { PublicKey, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, LAMPORTS_PER_SOL };
