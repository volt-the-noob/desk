import { createRequire } from 'node:module';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import { connection, sendTx, sendAll } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

// The SDK's ESM build has a broken anchor import; the CJS build is fine and exposes the class as module.exports.
const require = createRequire(import.meta.url);
const DLMM = require('@meteora-ag/dlmm');
const { StrategyType } = DLMM;

const NATIVE = 'So11111111111111111111111111111111111111112';

export class Pool {
  constructor(dlmm) {
    this.dlmm = dlmm;
    this.address = dlmm.pubkey;
    this.mintX = dlmm.tokenX.publicKey;
    this.mintY = dlmm.tokenY.publicKey;
    this.decX = dlmm.tokenX.mint.decimals;
    this.decY = dlmm.tokenY.mint.decimals;
    this.programX = dlmm.tokenX.owner;           // TOKEN_PROGRAM or TOKEN_2022
    this.reserveX = dlmm.tokenX.reserve;
    this.reserveY = dlmm.tokenY.reserve;
    this.binStep = dlmm.lbPair.binStep;
    if (this.mintY.toBase58() !== NATIVE) {
      throw new Error(`Pool ${this.address.toBase58()} is not SOL-quoted (token Y = ${this.mintY.toBase58()}). This desk only runs X/SOL pools.`);
    }
  }

  static async load(address) {
    const dlmm = await DLMM.create(connection, new PublicKey(address), { cluster: 'mainnet-beta' });
    const p = new Pool(dlmm);
    const fee = dlmm.getFeeInfo();
    log.info(`pool ${address} X=${p.mintX.toBase58()} (dec ${p.decX}) binStep=${p.binStep} baseFee=${fee.baseFeeRatePercentage}%`);
    return p;
  }

  xUi(raw) { return Number(raw) / 10 ** this.decX; }
  xRaw(ui) { return BigInt(Math.floor(ui * 10 ** this.decX)); }

  /** Current active bin + SOL-per-token price. */
  async price() {
    await this.dlmm.refetchStates();
    const ab = await this.dlmm.getActiveBin();
    const pricePerToken = Number(this.dlmm.fromPricePerLamport(Number(ab.price)));
    return { binId: ab.binId, price: pricePerToken };
  }

  /** The desk's position in this pool (first one), or null. */
  async position(owner) {
    const { userPositions } = await this.dlmm.getPositionsByUserAndLbPair(owner);
    if (!userPositions.length) return null;
    if (userPositions.length > 1) log.warn(`wallet has ${userPositions.length} positions in pool; using the first`);
    return userPositions[0];
  }

  /** What a position currently holds, in ui units + SOL value at `price`. */
  positionValue(pos, price) {
    const d = pos.positionData;
    const x = this.xUi(d.totalXAmount);
    const y = Number(d.totalYAmount) / LAMPORTS_PER_SOL;
    const feeX = this.xUi(d.feeX.toString());
    const feeY = Number(d.feeY.toString()) / LAMPORTS_PER_SOL;
    return {
      x, y, feeX, feeY,
      lower: d.lowerBinId, upper: d.upperBinId,
      valueSol: y + x * price,
      feesSol: feeY + feeX * price,
    };
  }

  /**
   * Open a position with the given raw amounts around the active bin.
   * Side selection: if there is no X we only bid below, if there is no SOL we only ask above.
   */
  async open(wallet, { xRaw, yLamports, activeId }) {
    const hasX = xRaw > 0n;
    const hasY = yLamports > 0n;
    if (!hasX && !hasY) throw new Error('nothing to deposit');
    const minBinId = hasY ? activeId - cfg.binsBelow : activeId;
    const maxBinId = hasX ? activeId + cfg.binsAbove : activeId;
    const position = Keypair.generate();
    const tx = await this.dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: wallet.publicKey,
      totalXAmount: new BN(xRaw.toString()),
      totalYAmount: new BN(yLamports.toString()),
      strategy: { minBinId, maxBinId, strategyType: StrategyType[cfg.strategy] },
      slippage: cfg.addLiquiditySlippagePct,
    });
    const txs = Array.isArray(tx) ? tx : [tx];
    const sigs = await sendAll(txs, [wallet, position], 'open-position');
    return { positionPubkey: position.publicKey, minBinId, maxBinId, sigs };
  }

  /** Remove 100%, claim fees, close the account. */
  async close(wallet, pos) {
    const txs = await this.dlmm.removeLiquidity({
      user: wallet.publicKey,
      position: pos.publicKey,
      fromBinId: pos.positionData.lowerBinId,
      toBinId: pos.positionData.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    return sendAll(txs, [wallet], 'close-position');
  }

  async claimFees(wallet, pos) {
    const txs = await this.dlmm.claimSwapFee({ owner: wallet.publicKey, position: pos });
    return sendAll(txs, [wallet], 'claim-fees');
  }

  /**
   * Swap inside this pool. swapForY=true sells X for SOL; false buys X with SOL.
   * Returns { inRaw, outRaw, sigs }. Loops on partial fills (thin pools).
   */
  async swap(wallet, { inRaw, swapForY }) {
    let remaining = new BN(inRaw.toString());
    let totalOut = new BN(0);
    let totalIn = new BN(0);
    const sigs = [];
    const [inToken, outToken] = swapForY ? [this.mintX, this.mintY] : [this.mintY, this.mintX];
    for (let i = 0; i < 4 && remaining.gtn(0); i++) {
      const binArrays = await this.dlmm.getBinArrayForSwap(swapForY, 10);
      const q = this.dlmm.swapQuote(remaining, swapForY, new BN(cfg.swapSlippageBps), binArrays, true);
      if (q.consumedInAmount.isZero()) break;
      const tx = await this.dlmm.swap({
        inToken, outToken,
        inAmount: q.consumedInAmount,
        minOutAmount: q.minOutAmount,
        lbPair: this.address,
        user: wallet.publicKey,
        binArraysPubkey: q.binArraysPubkey,
      });
      sigs.push(await sendTx(tx, [wallet], swapForY ? 'sell-x' : 'buy-x'));
      totalIn = totalIn.add(q.consumedInAmount);
      totalOut = totalOut.add(q.outAmount);
      remaining = remaining.sub(q.consumedInAmount);
      await this.dlmm.refetchStates();
    }
    return { inRaw: BigInt(totalIn.toString()), outRaw: BigInt(totalOut.toString()), sigs };
  }
}
