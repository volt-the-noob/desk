import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createBurnInstruction } from '@solana/spl-token';
import { sendVersioned, sendTx, toLamports, tokenBalanceRaw } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

const JUP = cfg.jupApiKey ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
const SOLM = 'So11111111111111111111111111111111111111112';

/**
 * Buy back the holder token with `sol` SOL, routed by Jupiter but restricted to BUYBACK_DEXES
 * (default: PumpSwap once the coin has graduated, the pump.fun bonding curve before that), then burn everything the desk wallet holds of it. Returns { sol, tokensBought, tokensBurned, txs }.
 * In dry run it only quotes and reports what it would have bought.
 */
export async function buybackAndBurn({ wallet, holderToken, sol }) {
  const out = { sol: 0, tokensBought: 0, tokensBurned: 0, txs: [] };
  if (sol < 0.001) return out;
  const amount = toLamports(sol);
  const q = await (await fetch(`${JUP}/quote?inputMint=${SOLM}&outputMint=${holderToken.mint.toBase58()}&amount=${amount}&slippageBps=${cfg.buybackSlippageBps}${cfg.buybackDexes ? `&dexes=${encodeURIComponent(cfg.buybackDexes)}` : ''}`)).json();
  const venue = (q?.routePlan ?? []).map((r) => r.swapInfo?.label).join(' → ');
  if (!q?.outAmount) throw new Error(`jupiter quote failed: ${JSON.stringify(q).slice(0, 200)}`);
  const quoted = Number(q.outAmount) / 10 ** holderToken.decimals;
  if (cfg.dryRun) {
    log.info(`[dry-run] buyback ${sol.toFixed(4)} SOL via ${venue} → ~${quoted.toFixed(0)} tokens, then burn`);
    return { sol, tokensBought: quoted, tokensBurned: quoted, txs: [], venue };
  }
  const before = await tokenBalanceRaw(wallet.publicKey, holderToken.mint, holderToken.programId);
  const swap = await (await fetch(`${JUP}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
  })).json();
  if (!swap?.swapTransaction) throw new Error(`jupiter swap build failed: ${JSON.stringify(swap).slice(0, 200)}`);
  out.txs.push(await sendVersioned(swap.swapTransaction, wallet, 'buyback'));
  const after = await tokenBalanceRaw(wallet.publicKey, holderToken.mint, holderToken.programId);
  const bought = after - before;
  out.sol = sol;
  out.tokensBought = Number(bought) / 10 ** holderToken.decimals;
  if (after > 0n) {
    const ata = getAssociatedTokenAddressSync(holderToken.mint, wallet.publicKey, false, holderToken.programId);
    const tx = new Transaction().add(createBurnInstruction(ata, holderToken.mint, wallet.publicKey, after, [], holderToken.programId));
    out.txs.push(await sendTx(tx, [wallet], 'burn'));
    out.tokensBurned = Number(after) / 10 ** holderToken.decimals;
  }
  out.venue = venue;
  log.info(`buyback via ${venue}: ${sol.toFixed(4)} SOL → ${out.tokensBought.toFixed(0)} tokens, burned ${out.tokensBurned.toFixed(0)}`);
  return out;
}
