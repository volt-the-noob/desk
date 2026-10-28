import http from 'node:http';
import { cfg, assertConfig } from './config.js';
import { loadWallet, solBalance } from './chain.js';
import { Fund } from './fund.js';
import { ledger } from './ledger.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assertConfig();
  if (cfg.chain === 'robinhood') return mainEvm();
  const wallet = loadWallet();
  log.info(`desk "${cfg.deskName}" wallet ${wallet.publicKey.toBase58()} balance ${(await solBalance(wallet.publicKey)).toFixed(4)} SOL dryRun=${cfg.dryRun}${cfg.dryRunSol ? ` paper=${cfg.dryRunSol} SOL` : ''}`);

  const fund = new Fund(wallet);
  await fund.boot();

  let last = { ok: true, at: null, error: null };
  const json = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(json({ ok: last.ok, last_tick: last.at, error: last.error }));
    if (req.url === '/state') return res.end(json({ ...fund.s, nextPayoutAt: new Date(fund.nextPayoutAt()).toISOString(), bands: fund.openBands().map((b) => ({ symbol: b.symbol, pool: b.address, ...b.s })), candidates: fund.candidates.slice(0, 10), dryRun: cfg.dryRun }));
    res.writeHead(404); res.end('{}');
  }).listen(cfg.port, () => log.info(`http on :${cfg.port}`));

  let errorStreak = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      await fund.tick();
      last = { ok: true, at: new Date().toISOString(), error: null };
      errorStreak = 0;
    } catch (e) {
      errorStreak++;
      last = { ok: false, at: new Date().toISOString(), error: e.message };
      log.error(`tick failed (${errorStreak}): ${e.stack || e.message}`);
      if (errorStreak === 1 || errorStreak % 10 === 0) await ledger.event('error', { detail: { message: e.message, streak: errorStreak } });
    }
    const wait = Math.max(1000, cfg.tickMs - (Date.now() - t0)) * (errorStreak ? Math.min(errorStreak, 8) : 1);
    await sleep(wait);
  }
}

/** Robinhood Chain: pons v2 creator tax → USDG → daily payouts. Same ledger, same clock, same site. */
async function mainEvm() {
  const { EvmFund } = await import('./evm/fund.js');
  const fund = new EvmFund();
  await fund.boot();
  let last = { ok: true, at: null, error: null };
  const json = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(json({ ok: last.ok, last_tick: last.at, error: last.error }));
    if (req.url === '/state') return res.end(json({ chain: 'robinhood', ...fund.s, tax: fund.tax.view(), nextPayoutAt: new Date(fund.nextPayoutAt()).toISOString(), dryRun: cfg.dryRun }));
    res.writeHead(404); res.end('{}');
  }).listen(cfg.port, () => log.info(`http on :${cfg.port}`));
  let errorStreak = 0;
  for (;;) {
    const t0 = Date.now();
    try { await fund.tick(); last = { ok: true, at: new Date().toISOString(), error: null }; errorStreak = 0; }
    catch (e) {
      errorStreak++;
      last = { ok: false, at: new Date().toISOString(), error: e.shortMessage ?? e.message };
      log.error(`tick failed (${errorStreak}): ${e.stack || e.message}`);
      if (errorStreak === 1 || errorStreak % 10 === 0) await ledger.event('error', { detail: { message: e.shortMessage ?? e.message, streak: errorStreak } });
    }
    await sleep(Math.max(1000, cfg.tickMs - (Date.now() - t0)) * (errorStreak ? Math.min(errorStreak, 8) : 1));
  }
}

main().catch((e) => { log.error(`fatal: ${e.stack || e.message}`); process.exit(1); });
