import { VersionedTransaction } from '@solana/web3.js';
import { connection, sendVersioned, tokenBalanceRaw, solBalance, toLamports } from './chain.js';
import { cfg } from './config.js';

const API = cfg.jupApiKey ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
const HEADERS = cfg.jupApiKey ? { 'x-api-key': cfg.jupApiKey } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// one request at a time, spaced out; the free endpoint rate-limits bursts
let chain = Promise.resolve(), last = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = cfg.jupMinIntervalMs - (Date.now() - last); if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { last = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}
async function jfetch(url, init = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await throttled(() => fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } }));
    if (r.status !== 429) return r;
    await sleep(1500 * (i + 1));
  }
  throw new Error('jupiter: rate limited');
}
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function quote(inMint, outMint, amountRaw, slippageBps = 50) {
  const r = await jfetch(`${API}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountRaw}&slippageBps=${slippageBps}`);
  const q = await r.json();
  if (!q?.outAmount) throw new Error(`jupiter quote ${inMint.slice(0, 4)}→${outMint.slice(0, 4)}: ${JSON.stringify(q).slice(0, 160)}`);
  q.venue = [...new Set((q.routePlan ?? []).map((x) => x.swapInfo?.label))].join('/');
  return q;
}

/**
 * Execute a quote. Returns { inRaw, outRaw, sig } measured from balance changes (live) or the quote (dry run).
 * outProgram: token program of the output mint, to read its balance (null for SOL).
 */
export async function swap(wallet, q, { outMint, outProgram } = {}) {
  if (cfg.dryRun) return { inRaw: BigInt(q.inAmount), outRaw: BigInt(q.outAmount), sig: `dry-run-swap-${Date.now()}` };
  const bal = async () => (outMint === SOL_MINT ? BigInt(toLamports(await solBalance(wallet.publicKey))) : tokenBalanceRaw(wallet.publicKey, new (await import('@solana/web3.js')).PublicKey(outMint), outProgram));
  const before = await bal();
  const r = await jfetch(`${API}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) });
  const j = await r.json();
  if (!j?.swapTransaction) throw new Error(`jupiter swap build: ${JSON.stringify(j).slice(0, 160)}`);
  const sig = await sendVersioned(j.swapTransaction, wallet, `swap ${q.inputMint.slice(0, 4)}→${q.outputMint.slice(0, 4)}`);
  const after = await bal();
  return { inRaw: BigInt(q.inAmount), outRaw: after - before, sig };
}
