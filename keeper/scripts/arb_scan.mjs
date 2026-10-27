// Live cross-venue arbitrage scan. For each token: executable quote to BUY with SIZE SOL on each venue, then quote to SELL
// the same tokens on every other venue. Profit = SOL back − SOL in − network cost. Both legs in one transaction with a
// minimum-out on leg 2 means an unprofitable trade simply reverts, so only the network fee is ever at risk.
import fs from 'node:fs';
const SOL = 'So11111111111111111111111111111111111111112', SIZE = Number(process.argv[2] ?? 0.5), ROUND = process.argv[3] ?? '1';
const NET_COST = 0.00006; // base fee + priority fee for one ~2-leg tx, in SOL
const U = JSON.parse(fs.readFileSync('/tmp/arb-universe.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function q(inMint, outMint, amount, dex) {
  const wait = 1050 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=50&dexes=${encodeURIComponent(dex)}&onlyDirectRoutes=true`);
  if (r.status === 429) { await sleep(3000); return q(inMint, outMint, amount, dex); }
  const j = await r.json(); return j.outAmount ? BigInt(j.outAmount) : null;
}
const rows = [];
const t0 = Date.now();
for (const t of U) {
  if (Date.now() - t0 > 250e3) break;
  const venues = Object.keys(t.venues);
  const buys = {};
  for (const v of venues) buys[v] = await q(SOL, t.mint, Math.round(SIZE * 1e9), v);
  const best = venues.filter((v) => buys[v]).sort((a, b) => (buys[b] > buys[a] ? 1 : -1))[0];
  if (!best) continue;
  for (const sv of venues) {
    if (sv === best) continue;
    const back = await q(t.mint, SOL, buys[best].toString(), sv);
    if (!back) continue;
    const pnl = Number(back) / 1e9 - SIZE - NET_COST;
    rows.push({ round: ROUND, ts: new Date().toISOString(), sym: t.sym, buy: best, sell: sv, pnl, bps: pnl / SIZE * 1e4 });
  }
  // also the reverse direction from the best sell venue is covered on the next round via the cheapest buy venue
}
fs.appendFileSync('/tmp/arb-samples.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
rows.sort((a, b) => b.bps - a.bps);
console.log(`round ${ROUND} · size ${SIZE} SOL · ${rows.length} venue pairs checked across ${new Set(rows.map((r) => r.sym)).size} tokens in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('best round trips (after fees + network cost):');
for (const r of rows.slice(0, 10)) console.log(`  ${r.sym.padEnd(10)} buy ${r.buy.padEnd(16)} → sell ${r.sell.padEnd(16)} ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(5)} SOL (${r.bps >= 0 ? '+' : ''}${r.bps.toFixed(1)} bps)`);
console.log(`profitable: ${rows.filter((r) => r.pnl > 0).length} of ${rows.length}`);
