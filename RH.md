# DESK on Robinhood Chain (pons v2)

Verified on-chain against live 2%-tax launches before anything was built.

## How the money moves
```
every $DESK trade on the pons curve → creatorTaxBps (your 2%) accrues in curve.creatorTaxBalance()
        │  swept to the shared FeeEscrow, credited to the fee recipient
        ▼  keeper: rescueFees() → escrow.claim()           every 5 min, or at $100
   ETH claimed  ──swap on claim (Uniswap V3 0.01% pool)──►  USDG
        ▼
      the pot ── daily split ──► holders in USDG (pro rata) · OPS · buybacks
```
Your 2% is yours in full: pons takes its own 1% separately (`quoteFeeBalance`), it is not a split of your tax.

## Verified facts (reads against live tokens, Oct 2026)
- chain id 4663 · RPC `https://rpc.mainnet.chain.robinhood.com` · block ~100.1M
- curve getters: `creatorTaxBps()` `creatorTaxBalance()` `quoteFeeBalance()` `isNativeQuote()` `graduated()`
  `readyToGraduate()` `quoteReserve()` `graduationThreshold()` (4.2 ETH) `feeEscrow()` `rescueFees()`
  `setCreatorFeeRecipient(address)` · snipe tax starts 9900bps and decays over 3s (bot protection on launch)
- FeeEscrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`: `credit(address)` `claim()` `claimToken(address)` — held 829 ETH
- USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168` · WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- best ETH/USDG route: Uniswap V3 **0.01%** pool `0x52e65b17…71ca` (~$12.8M liq, ~$98M/24h); router
  `0xCaf681a6…5cb2`, QuoterV2 `0x33e885eD…A9E7` — both deployed and answering

## Built
- `src/evm/chain.js` — viem clients, wallet, simulate-then-send (dry run still simulates against the live chain)
- `src/evm/pons.js` — tax reader + claimer (curve sweep → escrow claim), swaps to USDG on claim, books into the pot
- `src/evm/swap.js` — ETH↔USDG via Uniswap V3, quote-first with a slippage floor, best fee tier chosen per swap
- `src/evm/holders.js` — holder snapshot by indexing Transfer logs in bounded chunks; contracts/burn/desk excluded;
  pro-rata USDG payouts with dust accrual (same model as the Solana desk)

Tested live: swap quotes (1 ETH → 2,336 USDG), tax state on a real 2% token (graduation 79.7%), and holder
indexing (676 transfers → 49 eligible holders, contracts filtered).

- `src/evm/fund.js` — the desk itself: pot, daily clock, USDG payouts, OPS leg, buyback & burn, gas top-up,
  state written to the same Supabase ledger and site as the Solana desk
- `src/index.js` — `CHAIN=robinhood` boots the EVM desk; `CHAIN=solana` is unchanged

## Buyback routing (verified)
- **Pre-graduation** (the launch state): no Uniswap pool exists, so the desk sells USDG for ETH and buys on the
  bonding curve (`buy(minOut, deadline, to)` payable). Confirmed against a live un-graduated token.
- **After graduation**: USDG → WETH → token through the V3 router, because pons pools are WETH-paired.
  Confirmed live: 500 USDG → 1,717 PONS via the two-hop route.

## Full cycle tested (dry run, live chain)
5,000 USDG of tax income → holders 2,500 (paid to 30 of 32 eligible wallets, dust accrued) · reserve 1,500 ·
buyback 500 (pre-graduation path) · OPS 500. Pot after: 500 (the OPS leg correctly refused on an unfunded test wallet).

## Claim path — verified end to end (the last unknown, now closed)
- The creator tax accrues on the curve, and **pons automation sweeps it into the FeeEscrow by itself** — the desk does
  not call `rescueFees()` (that reverts; it isn't ours to call).
- A recipient reads what it is owed with **`balanceOf(address)`** on the escrow (not `credit()`, which does not exist)
  and withdraws with **`claim()`**, callable by the recipient with no permissions.
- Proven against a live creator wallet: the keeper's own code read **0.554 ETH owed** to it and its `claim()`
  transaction simulated successfully as that wallet. A live escrow `claim()` (selector 0x4e71d92d) was also observed
  landing on-chain from another creator wallet.
- Until the sweep happens, the tax sits on the curve; the keeper logs that and waits rather than sending a doomed tx.

## Test suite — 22/22 passing against mainnet
`node suite` covers: chain id and block, wallet derivation, balances · ETH/USDG price and both swap routes, the
two-hop buyback route, and correct rejection of a curve-only token · curve/escrow discovery, tax rate, graduation
progress, claim simulation, and no spurious claim when nothing is owed · holder indexing, contract/burn exclusion,
shares summing to exactly 100% · income into the pot, exact 50/30/10/10 splits, a full payout, pot conservation
(nothing vanishes), state writes, and a clean skip on an empty pot.

## Site (done)
One codebase serves both chains, switching on `desk_state.chain`. Nothing is forked: the Solana view is byte-for-byte
what it was (verified side by side after every change).
- units follow the desk (`SOL` or `USDG`) everywhere: figures, blotter, payout clock, position rows
- a **Creator tax** panel on RH: tax %, claimed so far (ETH → USDG into the pot), waiting to claim, graduation progress
- pool/stock sections, their tiles and their nav links hide on RH
- **all explanatory copy is rewritten for RH**: the hero and lede, the four-step "How it pays" rail (the tax → the
  claim → the swap → the clock), the About prose, and the FAQ (where the money comes from, the split read from live
  config, a bad day, whether the desk can lose everything, whether it trades the token). The stock-desk question hides.
- page title, header subtitle and HUD change; the buy button points at the pons launchpad once CONTRACT_ADDRESS is set

## Still to do
- pool desk on Uniswap v4 / Ramses DLMM (the sleeve, breaker and risk logic port over unchanged)

## Launch settings (Railway)
```
CHAIN=robinhood · EVM_PRIVATE_KEY=<desk wallet> · EVM_TOKEN_ADDRESS=<your token> · EVM_TOKEN_DEPLOY_BLOCK=<launch block>
EVM_OPS_WALLET=<ops> · DRY_RUN=false when ready
```
Set the token's **creator fee wallet to the desk wallet** at launch (or call `setCreatorFeeRecipient` later).
The desk wallet needs ~0.01 ETH for gas; it tops itself up from USDG after that.
