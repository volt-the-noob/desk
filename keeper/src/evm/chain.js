import { createPublicClient, createWalletClient, http, parseAbi, formatEther, formatUnits, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cfg } from '../config.js';
import { log } from '../log.js';

/** Robinhood Chain (Arbitrum Orbit L2, chain id 4663). */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [cfg.evmRpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

export const pub = createPublicClient({ chain: robinhood, transport: http(cfg.evmRpcUrl, { batch: true, retryCount: 3 }) });

let account = null, wallet = null;
export function evmAccount() {
  if (account) return account;
  if (!cfg.evmPrivateKey) throw new Error('EVM_PRIVATE_KEY not set');
  const k = cfg.evmPrivateKey.startsWith('0x') ? cfg.evmPrivateKey : `0x${cfg.evmPrivateKey}`;
  account = privateKeyToAccount(k);
  return account;
}
export function evmWallet() {
  if (!wallet) wallet = createWalletClient({ account: evmAccount(), chain: robinhood, transport: http(cfg.evmRpcUrl) });
  return wallet;
}

export const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const ethBalance = async (addr) => Number(formatEther(await pub.getBalance({ address: addr })));
export async function tokenBalance(token, owner) {
  const [raw, dec] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [owner] }),
    tokenDecimals(token),
  ]);
  return Number(formatUnits(raw, dec));
}
const decCache = new Map();
export async function tokenDecimals(token) {
  if (decCache.has(token)) return decCache.get(token);
  const d = await pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' });
  decCache.set(token, d);
  return d;
}

/**
 * Send a transaction and wait for it to land. In dry run nothing is signed: the call is simulated against the live
 * chain first, so a transaction that would revert still fails here, loudly, exactly as it would live.
 */
export async function send({ address, abi, functionName, args = [], value = 0n, label = 'tx' }) {
  const acct = evmAccount();
  const { request } = await pub.simulateContract({ address, abi, functionName, args, value, account: acct });
  if (cfg.dryRun) { log.info(`[dry-run] would send ${label} (simulated ok)`); return `dry-run-${label}-${Date.now()}`; }
  const hash = await evmWallet().writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== 'success') throw new Error(`${label} reverted on-chain: ${hash}`);
  log.info(`${label} confirmed ${hash}`);
  return hash;
}

/** Plain native-ETH transfer (used for refunds; payouts go out in USDG). */
export async function sendEth(to, amountWei, label = 'eth-transfer') {
  if (cfg.dryRun) { log.info(`[dry-run] would send ${formatEther(amountWei)} ETH to ${to}`); return `dry-run-${label}-${Date.now()}`; }
  const hash = await evmWallet().sendTransaction({ to, value: amountWei });
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}

/** ERC-20 transfer, used for the USDG payouts. */
export async function sendToken(token, to, amountRaw, label = 'token-transfer') {
  return send({ address: token, abi: ERC20, functionName: 'transfer', args: [to, amountRaw], label });
}

export { formatEther, formatUnits };
