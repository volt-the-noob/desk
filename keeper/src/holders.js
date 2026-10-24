import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { connection } from './chain.js';
import { cfg } from './config.js';
import { log } from './log.js';

const BURN = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
]);

/** Resolve a mint's token program + decimals once. */
export async function mintInfo(mintStr) {
  const mint = new PublicKey(mintStr);
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mintStr} not found`);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(connection, mint, 'confirmed', programId);
  return { mint, programId, decimals: m.decimals };
}

/**
 * Snapshot every wallet holding `mint`. Returns [{ wallet, raw: bigint }], sorted desc, capped.
 * Program-owned token accounts (pool vaults, bonding curves, lockers) are dropped because their
 * owner is an off-curve PDA, so no manual exclusion list is needed for them.
 */
export async function snapshotHolders({ mint, programId, decimals }, deskWallet) {
  const is2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
  const filters = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
  if (!is2022) filters.unshift({ dataSize: 165 });

  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed', filters, dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
  });

  const minRaw = BigInt(Math.floor(cfg.minHoldTokens * 10 ** decimals));
  const exclude = new Set([deskWallet.toBase58(), ...cfg.excludeWallets, ...BURN, cfg.opsWallet].filter(Boolean));
  const byOwner = new Map();
  for (const { account } of accounts) {
    const data = account.data;
    const owner = new PublicKey(data.subarray(0, 32));
    const amount = data.readBigUInt64LE(32);
    if (amount === 0n) continue;
    const o = owner.toBase58();
    if (exclude.has(o)) continue;
    if (!PublicKey.isOnCurve(owner.toBytes())) continue; // PDA → program vault, not a person
    byOwner.set(o, (byOwner.get(o) ?? 0n) + amount);
  }
  let holders = [...byOwner.entries()].map(([wallet, raw]) => ({ wallet, raw }))
    .filter((h) => h.raw >= minRaw)
    .sort((a, b) => (a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0));
  const total = holders.length;
  if (holders.length > cfg.maxHolders) holders = holders.slice(0, cfg.maxHolders);
  log.info(`holder snapshot: ${accounts.length} token accounts → ${total} eligible wallets (using ${holders.length})`);
  return holders;
}
