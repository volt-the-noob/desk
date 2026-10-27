import { createRequire } from 'node:module';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { connection, sendTx } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

// pump.fun's PumpSwap SDK (CJS build; same ESM issue as the other SDKs)
const require = createRequire(import.meta.url);
const A = require('@pump-fun/pump-swap-sdk');
const sdk = new A.OnlinePumpAmmSdk(connection);
const SLIP = 1; // percent
const NATIVE = 'So11111111111111111111111111111111111111112';
let feeConfig = null;

/** A PumpSwap pool (constant product, full range): coin / SOL. */
export class PumpPool {
  constructor(key, pool, dec, programX) {
    this.venue = 'pumpswap';
    this.address = key; this.key = key; this.pool = pool;
    this.mintX = pool.baseMint; this.programX = programX; this.decX = dec;
    this.binStep = null;
  }

  static async load(address) {
    const key = new PublicKey(address);
    const pool = await sdk.fetchPool(key);
    if (pool.quoteMint.toBase58() !== NATIVE) throw new Error(`PumpSwap pool ${address} is not quoted in SOL`);
    const mintInfo = await connection.getParsedAccountInfo(pool.baseMint);
    const p = new PumpPool(key, pool, mintInfo.value.data.parsed.info.decimals, mintInfo.value.owner);
    feeConfig ??= await sdk.fetchFeeConfigAccount().catch(() => null);
    log.info(`pumpswap pool ${address} base ${p.mintX.toBase58()} (dec ${p.decX})`);
    return p;
  }

  xUi(raw) { return Number(raw) / 10 ** this.decX; }
  xRaw(ui) { return BigInt(Math.floor(ui * 10 ** this.decX)); }

  /** Reserves, LP supply and SOL-per-token price, fresh from chain. */
  async state(user) {
    const st = await sdk.liquiditySolanaState(this.key, user);
    const base = BigInt(st.poolBaseTokenAccount.amount), quote = BigInt(st.poolQuoteTokenAccount.amount), lpSupply = BigInt(st.pool.lpSupply.toString());
    const price = (Number(quote) / 1e9) / this.xUi(base);
    return { st, base, quote, lpSupply, price, kPerLp: Math.sqrt(Number(base) * Number(quote)) / Number(lpSupply) };
  }

  /** LP fee this pool pays liquidity providers right now (bps), from pump.fun's market-cap fee tiers. */
  lpFeeBps(marketCapLamports) {
    try { if (feeConfig?.feeTiers?.length) return Number(A.calculateFeeTier({ feeTiers: feeConfig.feeTiers, marketCap: new BN(marketCapLamports.toString()) }).lpFeeBps.toString()); } catch {}
    return 20;
  }

  async send(ixs, wallet, label) { const tx = new Transaction().add(...ixs); return sendTx(tx, [wallet], label); }

  /** Deposit `quoteLamports` SOL plus the matching coin amount (bought first, in this pool). Returns lp, base, quote, sigs. */
  async deposit(wallet, quoteLamports) {
    const s = await this.state(wallet.publicKey);
    const dep = A.PUMP_AMM_SDK.depositAutocompleteBaseAndLpTokenFromQuote(s.st, new BN(quoteLamports.toString()), SLIP);
    const sigs = [];
    // buy the coin side in this same pool (a little extra for rounding)
    const needBase = new BN(dep.base.toString()).muln(1005).divn(1000);
    const sw = await sdk.swapSolanaState(this.key, wallet.publicKey);
    sigs.push(await this.send(await A.PUMP_AMM_SDK.buyBaseInput(sw, needBase, SLIP), wallet, 'pumpswap-buy'));
    const s2 = await this.state(wallet.publicKey);
    const dep2 = A.PUMP_AMM_SDK.depositAutocompleteBaseAndLpTokenFromQuote(s2.st, new BN(quoteLamports.toString()), SLIP);
    sigs.push(await this.send(await A.PUMP_AMM_SDK.depositInstructions(s2.st, dep2.lpToken, SLIP), wallet, 'pumpswap-deposit'));
    const buyCost = Number(needBase.toString()) / 10 ** this.decX * s.price * (1 + 0.0125);   // price + worst-case fee
    return { lp: BigInt(dep2.lpToken.toString()), base: BigInt(dep2.base.toString()), quote: BigInt(quoteLamports.toString()), buyCostSol: buyCost, sigs, kPerLp: s2.kPerLp };
  }

  /**
   * PumpSwap's withdraw pays the SOL side into the user's wrapped-SOL account and fails if that account doesn't exist
   * (the SDK doesn't create it, and deposits close it). Wrap the withdraw: create it first, unwrap it to SOL after.
   */
  withWsol(user, ixs) {
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);
    return [createAssociatedTokenAccountIdempotentInstruction(user, ata, user, NATIVE_MINT, TOKEN_PROGRAM_ID), ...ixs, createCloseAccountInstruction(ata, user, user, [], TOKEN_PROGRAM_ID)];
  }

  /** Withdraw `lp` and sell the coin side back to SOL in this pool. Returns SOL received in total. */
  async withdrawAndSell(wallet, lp) {
    const s = await this.state(wallet.publicKey);
    const out = A.PUMP_AMM_SDK.withdrawAutoCompleteBaseAndQuoteFromLpToken(s.st, new BN(lp.toString()), SLIP);
    const sigs = [await this.send(this.withWsol(wallet.publicKey, await A.PUMP_AMM_SDK.withdrawInstructions(s.st, new BN(lp.toString()), SLIP)), wallet, 'pumpswap-withdraw')];
    const base = new BN(out.base.toString());
    let sold = 0;
    if (base.gtn(0)) {
      const sw = await sdk.swapSolanaState(this.key, wallet.publicKey);
      sigs.push(await this.send(await A.PUMP_AMM_SDK.sellBaseInput(sw, base, SLIP), wallet, 'pumpswap-sell'));
      sold = this.xUi(BigInt(base.toString())) * s.price * (1 - 0.0125);
    }
    return { sol: Number(out.quote.toString()) / 1e9 + sold, quoteOut: Number(out.quote.toString()) / 1e9, soldSol: sold, sigs };
  }
}
