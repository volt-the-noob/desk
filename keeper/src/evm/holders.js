import { parseAbiItem, formatUnits, parseUnits } from 'viem';
import { pub, evmAccount, tokenDecimals, sendToken, ERC20 } from './chain.js';
import { USDG } from './swap.js';
import { cfg } from '../config.js';
import { ledger } from '../ledger.js';
import { log } from '../log.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

/**
 * Holder snapshot for an ERC-20 on Robinhood Chain.
 *
 * There is no getProgramAccounts equivalent on an EVM chain, so balances are rebuilt by indexing the token's Transfer
 * logs from its deploy block and kept warm from there: the first pass walks history in bounded chunks (the public RPC
 * rejects wide ranges), later passes only read new blocks. Contract addresses are skipped, so pools, the escrow, the
 * desk and burn addresses never receive a payout.
 */
export class Holders {
  constructor() {
    this.bal = new Map();     // address → bigint
    this.fromBlock = null;
    this.contracts = new Map(); // address → isContract
    this.decimals = null;
  }

  async isContract(addr) {
    if (this.contracts.has(addr)) return this.contracts.get(addr);
    const code = await pub.getBytecode({ address: addr }).catch(() => null);
    const is = !!code && code !== '0x';
    this.contracts.set(addr, is);
    return is;
  }

  /** Bring balances up to the current head. Returns the block synced to. */
  async sync() {
    const token = cfg.evmTokenAddress;
    this.decimals ??= await tokenDecimals(token);
    const head = await pub.getBlockNumber();
    let from = this.fromBlock ?? BigInt(cfg.evmTokenDeployBlock || 0);
    if (!this.fromBlock && !cfg.evmTokenDeployBlock) from = head > 2_000_000n ? head - 2_000_000n : 0n;
    const step = BigInt(cfg.evmLogChunk);
    let scanned = 0;
    while (from <= head) {
      const to = from + step > head ? head : from + step;
      const logs = await pub.getLogs({ address: token, event: TRANSFER, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const { from: f, to: t, value } = l.args;
        if (!DEAD.has(f.toLowerCase())) this.bal.set(f.toLowerCase(), (this.bal.get(f.toLowerCase()) ?? 0n) - value);
        if (!DEAD.has(t.toLowerCase())) this.bal.set(t.toLowerCase(), (this.bal.get(t.toLowerCase()) ?? 0n) + value);
      }
      scanned += logs.length;
      from = to + 1n;
    }
    this.fromBlock = head + 1n;
    if (scanned) log.info(`holders: indexed ${scanned} transfers up to block ${head}`);
    return head;
  }

  /** Eligible holders: positive balance, not a contract, not the desk or a burn address. */
  async snapshot() {
    await this.sync();
    const me = evmAccount().address.toLowerCase();
    const skip = new Set([me, (cfg.evmOpsWallet || '').toLowerCase(), ...DEAD]);
    const out = [];
    for (const [addr, raw] of this.bal) {
      if (raw <= 0n || skip.has(addr)) continue;
      if (await this.isContract(addr)) continue;      // pools, escrow, routers, multisigs
      out.push({ wallet: addr, raw });
    }
    out.sort((a, b) => (b.raw > a.raw ? 1 : -1));
    return out;
  }
}

/**
 * Pay holders their share of `amountUsdg` pro rata. Dust below MIN_PAYOUT_USDG accrues in the ledger instead of being
 * sent, so gas never eats a payout; accrued amounts go out once they cross the floor. Same accrual model as the
 * Solana desk, with USDG transfers instead of SOL.
 */
export async function payHolders({ holders, amountUsdg, availableUsdg, solUsd = 0 }) {
  const out = { allocated: 0, paid: 0, walletsPaid: 0, txCount: 0, holders: holders.length, payoutId: null };
  if (!holders.length || amountUsdg <= 0) return out;
  const dec = await tokenDecimals(USDG);
  const total = holders.reduce((a, h) => a + h.raw, 0n);
  if (total <= 0n) return out;

  const rows = holders.map((h) => ({ wallet: h.wallet, usdg: amountUsdg * Number(h.raw) / Number(total) }))
    .filter((r) => r.usdg > 0);
  out.allocated = rows.reduce((a, r) => a + r.usdg, 0);
  if (cfg.dryRun) {
    const sim = rows.filter((r) => r.usdg >= cfg.evmMinPayoutUsdg);
    out.paid = sim.reduce((a, r) => a + r.usdg, 0); out.walletsPaid = sim.length; out.txCount = sim.length;
    log.info(`[dry-run] would allocate ${out.allocated.toFixed(2)} USDG to ${rows.length} wallets and pay ${out.paid.toFixed(2)} to ${sim.length}`);
    out.payoutId = await ledger.recordPayout({ total_sol: out.paid, ops_sol: 0, sol_usd: 1, wallets: sim.length, tx_count: out.txCount, dry_run: true, pot_before: amountUsdg, holders_snapshot: holders.length }, sim.slice(0, 200).map((r) => ({ wallet: r.wallet, sol: r.usdg, tx: null })));
    return out;
  }

  await ledger.accrueOwed(rows.map((r) => ({ wallet: r.wallet, sol: r.usdg })));   // same table; the unit is USDG on this chain
  const owed = await ledger.payable(cfg.evmMinPayoutUsdg);
  let budget = Math.max(0, availableUsdg);
  const paid = [];
  for (const o of owed) {
    const amt = Math.min(Number(o.owed_sol), budget);
    if (amt < cfg.evmMinPayoutUsdg) continue;
    try {
      const tx = await sendToken(USDG, o.wallet, parseUnits(amt.toFixed(dec), dec), `payout ${o.wallet.slice(0, 10)}`);
      paid.push({ wallet: o.wallet, sol: amt, tx });
      budget -= amt; out.paid += amt; out.walletsPaid++; out.txCount++;
    } catch (e) { log.error(`payout to ${o.wallet} failed: ${e.shortMessage ?? e.message}`); }
    if (budget < cfg.evmMinPayoutUsdg) break;
  }
  if (paid.length) await ledger.markPaid(paid.map((p) => ({ wallet: p.wallet, sol: p.sol })));
  out.payoutId = await ledger.recordPayout({
    total_sol: out.paid, ops_sol: 0, sol_usd: 1, wallets: out.walletsPaid, tx_count: out.txCount,
    dry_run: cfg.dryRun, pot_before: amountUsdg, holders_snapshot: holders.length,
  }, paid);
  log.info(`paid ${out.paid.toFixed(2)} USDG to ${out.walletsPaid} wallets (allocated ${out.allocated.toFixed(2)} across ${holders.length})`);
  return out;
}
