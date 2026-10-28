import { parseAbi, parseEther, parseUnits, formatUnits } from 'viem';
import { pub, evmAccount, send, WETH, ERC20, tokenDecimals } from './chain.js';
import { cfg } from '../config.js';
import { log } from '../log.js';

/**
 * Swaps on Robinhood Chain through Uniswap V3.
 *
 * Verified live: the deepest ETH/USDG route is the 0.01% V3 pool (WETH is token0, USDG token1, ~$12.8M liquidity,
 * ~$98M daily volume), and both QuoterV2 and SwapRouter are deployed. Every swap is quoted first and sent with a
 * minimum-out derived from that quote, so a thin or moved market makes the transaction revert instead of filling badly.
 */
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2';
const QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';

const ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
  'function refundETH() payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
const QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** Best quote across the configured fee tiers. Returns { out, fee } with out in raw units of tokenOut. */
export async function quote(tokenIn, tokenOut, amountInRaw) {
  let best = { out: 0n, fee: null };
  for (const fee of cfg.evmFeeTiers) {
    try {
      const { result } = await pub.simulateContract({
        address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0n }],
        account: evmAccount().address,
      });
      const out = Array.isArray(result) ? result[0] : result;
      if (out > best.out) best = { out, fee };
    } catch { /* tier has no pool or no liquidity */ }
  }
  if (!best.fee) throw new Error(`no route ${tokenIn.slice(0, 8)}→${tokenOut.slice(0, 8)} on any fee tier`);
  return best;
}

async function ensureAllowance(token, amountRaw) {
  const me = evmAccount().address;
  const allowed = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [me, ROUTER] });
  if (allowed >= amountRaw) return;
  await send({ address: token, abi: ERC20, functionName: 'approve', args: [ROUTER, 2n ** 256n - 1n], label: 'approve-router' });
}

/** Swap native ETH → USDG. Returns USDG received (as a number). */
export async function swapEthToUsdg(amountEth) {
  const amountIn = parseEther(String(amountEth));
  const { out, fee } = await quote(WETH, USDG, amountIn);
  const minOut = out - (out * BigInt(Math.round(cfg.evmSlippageBps)) / 10_000n);
  const dec = await tokenDecimals(USDG);
  const expect = Number(formatUnits(out, dec));
  await send({
    address: ROUTER, abi: ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: WETH, tokenOut: USDG, fee, recipient: evmAccount().address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    value: amountIn, label: `swap ${amountEth.toFixed(6)} ETH→USDG`,
  });
  log.info(`swapped ${amountEth.toFixed(6)} ETH → ~${expect.toFixed(2)} USDG (tier ${fee / 10_000}%)`);
  return expect;
}

/** Swap USDG → native ETH (used to top the gas wallet back up). Returns ETH received. */
export async function swapUsdgToEth(amountUsdg) {
  const dec = await tokenDecimals(USDG);
  const amountIn = parseUnits(String(amountUsdg), dec);
  const { out, fee } = await quote(USDG, WETH, amountIn);
  const minOut = out - (out * BigInt(Math.round(cfg.evmSlippageBps)) / 10_000n);
  await ensureAllowance(USDG, amountIn);
  await send({
    address: ROUTER, abi: ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: USDG, tokenOut: WETH, fee, recipient: evmAccount().address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    label: `swap ${amountUsdg.toFixed(2)} USDG→ETH`,
  });
  return Number(out) / 1e18;
}

/** V3 path encoding: token (20) · fee (3) · token (20) … */
const encodePath = (tokens, fees) => '0x' + tokens[0].slice(2).toLowerCase()
  + fees.map((f, i) => f.toString(16).padStart(6, '0') + tokens[i + 1].slice(2).toLowerCase()).join('');

/** Best two-hop quote through WETH, for tokens that have no direct USDG pool (pons tokens are WETH-paired). */
async function quoteViaWeth(tokenIn, tokenOut, amountInRaw) {
  let best = { out: 0n, path: null };
  for (const f1 of cfg.evmFeeTiers) for (const f2 of cfg.evmFeeTiers) {
    const path = encodePath([tokenIn, WETH, tokenOut], [f1, f2]);
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInput', args: [path, amountInRaw], account: evmAccount().address });
      const out = Array.isArray(result) ? result[0] : result;
      if (out > best.out) best = { out, path };
    } catch { /* no pool at this tier pair */ }
  }
  return best;
}

/** Swap USDG → an arbitrary token (the buyback leg), direct if a pool exists, otherwise hopping through WETH. */
export async function swapUsdgToToken(amountUsdg, token) {
  const dec = await tokenDecimals(USDG);
  const amountIn = parseUnits(String(amountUsdg), dec);
  const r = await routeUsdgToToken(token, amountIn);
  const minOut = r.out - (r.out * BigInt(Math.round(cfg.evmSlippageBps)) / 10_000n);
  await ensureAllowance(USDG, amountIn);
  const label = `buyback ${amountUsdg.toFixed(2)} USDG→token`;
  if (r.path) return send({ address: ROUTER, abi: ROUTER_ABI, functionName: 'exactInput', args: [{ path: r.path, recipient: evmAccount().address, amountIn, amountOutMinimum: minOut }], label });
  return send({ address: ROUTER, abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: USDG, tokenOut: token, fee: r.fee, recipient: evmAccount().address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }], label });
}

/** Quote USDG → token, preferring a direct pool and falling back to USDG → WETH → token. */
export async function routeUsdgToToken(token, amountInRaw) {
  let direct = { out: 0n, fee: null };
  try { direct = await quote(USDG, token, amountInRaw); } catch { /* no direct pool */ }
  const hop = await quoteViaWeth(USDG, token, amountInRaw);
  if (hop.out > direct.out) return { out: hop.out, path: hop.path };
  if (direct.fee) return { out: direct.out, fee: direct.fee };
  throw new Error(`no route USDG→${token.slice(0, 8)} direct or via WETH`);
}

/** ETH price in USDG, from a 0.01 ETH quote — the price the desk can actually trade at. */
export async function ethUsd() {
  try {
    const { out } = await quote(WETH, USDG, parseEther('0.01'));
    const dec = await tokenDecimals(USDG);
    return Number(formatUnits(out, dec)) * 100;
  } catch { return null; }
}
