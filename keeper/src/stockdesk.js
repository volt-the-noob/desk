import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { tokenBalanceRaw, toLamports, solUsd } from './chain.js';
import { quote, swap, SOL_MINT, USDC_MINT } from './jup.js';
import { cfg } from './config.js';
import { ledger } from './ledger.js';
import { log } from './log.js';

// xStocks (Token-2022, 8 decimals) and their Pyth US equity feeds
export const BOOK = {
  NVDA: { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', pyth: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593' },
  TSLA: { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', pyth: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1' },
  SPY: { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', pyth: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5' },
  AAPL: { mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', pyth: '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688' },
  MSTR: { mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', pyth: 'e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09' },
  QQQ: { mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', pyth: '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d' },
  META: { mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', pyth: '78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe' },
  COIN: { mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', pyth: 'fee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245' },
};
const DEC = 1e8, HIST = 120;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const getJson = async (u, headers = {}) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', ...headers } }); if (!r.ok) throw new Error(`${r.status} ${u.slice(0, 60)}`); return r.json(); };
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Stock desk: tokenized stocks (xStocks) against the real stock price, during US market hours.
 *
 * Inventory model (no shorting): the desk holds USDC + a basket of xStocks. When a pool trades rich versus its usual
 * premium to the real price it sells a clip from inventory, and buys the same shares back once the gap closes; when a
 * pool trades cheap it buys a clip and sells it back. Each round trip ends with the same shares and more (or less) USDC.
 * Realised USD is converted to SOL and booked into the pot in sweeps.
 *
 * Modes: off · paper (logs trades on executable quotes, books nothing) · live (trades; with DRY_RUN=true the swaps are
 * simulated against the same quotes and booked to the paper bankroll, which rehearses the whole pipeline).
 */
export class StockDesk {
  constructor(fund) {
    this.fund = fund;
    this.tickers = (cfg.stockTickers.length ? cfg.stockTickers : ['NVDA', 'TSLA', 'SPY', 'AAPL']).filter((t) => BOOK[t]);
    this.hist = new Map(this.tickers.map((t) => [t, []]));
    this.streak = new Map(this.tickers.map((t) => [t, { rich: 0, cheap: 0 }]));
    this.open = new Map();
    this.board = {};
    this.lastAt = 0; this.lastSweepAt = 0;
    this.v = null;                    // virtual inventory for dry-run live mode: { usdc, shares: {t} }
    this.realisedUsd = 0; this.sweptUsd = 0;
    this.marketOpen = false;
    this.clipUsd = cfg.stockClipUsd || 500;   // re-sized from the book after setup when STOCK_CLIP_USD=0
    if (cfg.stockMode !== 'off') log.info(`stock desk (${cfg.stockMode}${cfg.stockMode === 'live' && cfg.dryRun ? ', dry-run' : ''}): ${this.tickers.join(', ')} · clip $${cfg.stockClipUsd || 'auto'} · enter at ${cfg.stockEnterPct}% · capital ${cfg.stockCapitalSol} SOL`);
  }

  live() { return cfg.stockMode === 'live'; }
  restore(row) {
    if (!row) return;
    this.realisedUsd = Number(row.stock_realised_usd ?? 0); this.sweptUsd = Number(row.stock_swept_usd ?? 0);   // live-only P&L, never paper
    if (row.stock_virtual && cfg.dryRun) this.v = row.stock_virtual;
    if (row.stock?.clip_usd && !cfg.stockClipUsd) this.clipUsd = row.stock.clip_usd;
    if (this.v || Number(row.stock_book_usd) > 1) this.setupDone = true;
  }

  // ---------- prices ----------
  async ref(t) {
    if (cfg.stockRefSource === 'pyth' && cfg.pythApiKey) {
      const j = await getJson(`https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=${BOOK[t].pyth}&parsed=true`, { authorization: `Bearer ${cfg.pythApiKey}` });
      const p = j.parsed[0].price; return { px: Number(p.price) * 10 ** p.expo, age: Date.now() / 1000 - p.publish_time };
    }
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1m&range=1d`);
    const m = j.chart.result[0].meta; return { px: m.regularMarketPrice, age: Date.now() / 1000 - m.regularMarketTime };
  }
  async quotes(t, px) {
    const clip = Math.round(this.clipUsd * 1e6), shares = Math.round((this.clipUsd / px) * DEC);
    const [b, s] = await Promise.all([quote(USDC_MINT, BOOK[t].mint, clip), quote(BOOK[t].mint, USDC_MINT, shares)]);
    return { b, s, buyPx: this.clipUsd / (Number(b.outAmount) / DEC), sellPx: Number(s.outAmount) / 1e6 / (shares / DEC), venue: [...new Set([b.venue, s.venue])].join('/') };
  }

  // ---------- inventory ----------
  async balances() {
    if (cfg.dryRun || !this.live()) return this.v ?? { usdc: 0, shares: Object.fromEntries(this.tickers.map((t) => [t, 0])) };
    const w = this.fund.wallet.publicKey, out = { usdc: Number(await tokenBalanceRaw(w, new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID)) / 1e6, shares: {} };
    for (const t of this.tickers) out.shares[t] = Number(await tokenBalanceRaw(w, new PublicKey(BOOK[t].mint), TOKEN_2022_PROGRAM_ID)) / DEC;
    return out;
  }

  /** First run: convert STOCK_CAPITAL_SOL into USDC, then put STOCK_INVENTORY_PCT of it into an even xStock basket. */
  async setup() {
    if (!this.live() || this.v || this.setupDone) return;
    const bal = await this.balances();
    const have = bal.usdc + Object.values(bal.shares).reduce((a, b) => a + b, 0);
    if (!cfg.dryRun && have > 1) { this.setupDone = true; if (!cfg.stockClipUsd) this.clipUsd = Math.floor((bal.usdc / this.tickers.length) * 0.9); return; }   // already funded on-chain
    const px = await solUsd(); if (!px) return;
    const lam = toLamports(cfg.stockCapitalSol);
    const q = await quote(SOL_MINT, USDC_MINT, lam, 50);
    const r = await swap(this.fund.wallet, q, { outMint: USDC_MINT, outProgram: TOKEN_PROGRAM_ID });
    let usdc = Number(r.outRaw) / 1e6;
    const inv = { usdc, shares: Object.fromEntries(this.tickers.map((t) => [t, 0])) };
    if (cfg.dryRun) this.fund.onPaperSpend(cfg.stockCapitalSol);
    const per = (usdc * cfg.stockInventoryPct / 100) / this.tickers.length;
    for (const t of this.tickers) {
      try {
        const qb = await quote(USDC_MINT, BOOK[t].mint, Math.round(per * 1e6), 50);
        const rb = await swap(this.fund.wallet, qb, { outMint: BOOK[t].mint, outProgram: TOKEN_2022_PROGRAM_ID });
        inv.shares[t] += Number(rb.outRaw) / DEC; inv.usdc -= per;
      } catch (e) { log.warn(`stock setup ${t}: ${e.message}`); }
    }
    if (cfg.dryRun) this.v = inv;
    this.setupDone = true;
    if (!cfg.stockClipUsd) this.clipUsd = Math.floor(per * 0.9);
    log.info(`stock desk funded: ${cfg.stockCapitalSol} SOL → $${r2(usdc)} · basket $${r2(per * this.tickers.length)} across ${this.tickers.length} stocks, $${r2(inv.usdc)} USDC free`);
    await ledger.event('stock-setup', { detail: { sol: cfg.stockCapitalSol, usdc: r2(usdc), basket_usd: r2(per * this.tickers.length), tickers: this.tickers } });
  }

  /** Book value of the stock desk in USD (USDC + shares at the real price, or the last pool bid off-hours). */
  async valueUsd() {
    if (!this.live()) return 0;
    const b = await this.balances();
    let v = b.usdc;
    for (const t of this.tickers) v += (b.shares[t] ?? 0) * (this.board[t]?.ref ?? this.board[t]?.bid ?? 0);
    return v;
  }

  // ---------- loop ----------
  async tick() {
    if (cfg.stockMode === 'off' || Date.now() - this.lastAt < cfg.stockTickSec * 1000) return;
    this.lastAt = Date.now();
    try { await this.setup(); } catch (e) { log.error(`stock setup failed: ${e.message}`); }
    let fresh = 0;
    for (const t of this.tickers) {
      let r, q;
      try { r = await this.ref(t); } catch (e) { log.warn(`stock ${t} ref: ${e.message}`); continue; }
      try { q = await this.quotes(t, r.px); } catch (e) { log.warn(`stock ${t} quote: ${e.message}`); continue; }
      const richGap = q.sellPx / r.px - 1, cheapGap = q.buyPx / r.px - 1, mid = (richGap + cheapGap) / 2;
      const live = r.px && r.age <= 180;
      if (live) fresh++;
      const h = this.hist.get(t);
      if (live) { h.push(mid); if (h.length > HIST) h.shift(); }
      const base = h.length ? median(h) : mid, enter = cfg.stockEnterPct / 100;
      this.board[t] = { t, ref: r.px, ref_age: Math.round(r.age), bid: r2(q.sellPx), ask: r2(q.buyPx), premium: r2(mid * 100 * 100) / 100, usual: r2(base * 100 * 100) / 100,
        gap: r2((richGap - base > -(cheapGap - base) ? richGap - base : cheapGap - base) * 100 * 100) / 100, venue: q.venue, open: this.open.get(t)?.side ?? null, warm: h.length >= 20 };
      if (!live || h.length < 20) continue;
      const st = this.streak.get(t);
      st.rich = richGap - base > enter ? st.rich + 1 : 0;
      st.cheap = cheapGap - base < -enter ? st.cheap + 1 : 0;
      const pos = this.open.get(t);
      if (pos) {
        const done = pos.side === 'sell' ? cheapGap <= base : richGap >= base;
        if (done || Date.now() - pos.at > 90 * 60e3) await this.close(t, pos, r.px, done ? 'gap closed' : 'timeout');
      } else if (this.open.size < cfg.stockMaxOpen) {
        if (st.rich >= cfg.stockPersistTicks) await this.enter(t, 'sell', r.px, richGap - base);
        else if (st.cheap >= cfg.stockPersistTicks) await this.enter(t, 'buy', r.px, cheapGap - base);
      }
    }
    this.marketOpen = fresh > 0;
    // market closed with trades still open: close them against the last pool price after a 90 min grace
    if (!this.marketOpen) for (const [t, pos] of this.open) if (Date.now() - pos.at > 90 * 60e3) await this.close(t, pos, this.board[t]?.ref ?? pos.ref, 'market closed');
    try { await this.sweep(); } catch (e) { log.error(`stock sweep failed: ${e.message}`); }
  }

  async enter(t, side, ref, gap) {
    const inv = this.live() ? await this.balances() : null;
    const shares = Math.round((this.clipUsd / ref) * DEC);
    if (inv && side === 'sell' && (inv.shares[t] ?? 0) * DEC < shares) { log.info(`stock ${t}: rich but no inventory to sell`); return; }
    if (inv && side === 'buy' && inv.usdc < this.clipUsd) { log.info(`stock ${t}: cheap but not enough USDC`); return; }
    // re-quote the exact clip and re-check the gap on what we would actually get
    const q = side === 'sell' ? await quote(BOOK[t].mint, USDC_MINT, shares) : await quote(USDC_MINT, BOOK[t].mint, Math.round(this.clipUsd * 1e6));
    const px = side === 'sell' ? Number(q.outAmount) / 1e6 / (shares / DEC) : this.clipUsd / (Number(q.outAmount) / DEC);
    let exec = { px, shares: side === 'sell' ? shares / DEC : Number(q.outAmount) / DEC, usd: side === 'sell' ? Number(q.outAmount) / 1e6 : this.clipUsd, sig: null };
    if (this.live()) {
      const out = side === 'sell' ? { outMint: USDC_MINT, outProgram: TOKEN_PROGRAM_ID } : { outMint: BOOK[t].mint, outProgram: TOKEN_2022_PROGRAM_ID };
      const r = await swap(this.fund.wallet, q, out);
      exec = side === 'sell' ? { ...exec, usd: Number(r.outRaw) / 1e6, sig: r.sig } : { ...exec, shares: Number(r.outRaw) / DEC, sig: r.sig };
      exec.px = exec.usd / exec.shares;
      if (this.v) { this.v.usdc += side === 'sell' ? exec.usd : -exec.usd; this.v.shares[t] += side === 'sell' ? -exec.shares : exec.shares; }
    }
    this.open.set(t, { t, side, ref, px: exec.px, shares: exec.shares, usd: exec.usd, entryGap: gap, at: Date.now() });
    log.info(`stock ${cfg.stockMode} OPEN ${side} ${t}x ${exec.shares.toFixed(4)} @ ${exec.px.toFixed(2)} vs real ${ref.toFixed(2)} (+${(Math.abs(gap) * 100).toFixed(2)}% over usual, via ${q.venue})`);
    await ledger.event('stock-open', { txs: exec.sig ? [exec.sig] : [], detail: { mode: cfg.stockMode, ticker: t, side, px: r2(exec.px), ref: r2(ref), gap_pct: r2(gap * 1e4) / 100, shares: exec.shares, usd: r2(exec.usd), venue: q.venue } });
  }

  async close(t, pos, ref, reason) {
    // undo the clip: bought-back shares for a sell, sold shares for a buy
    const q = pos.side === 'sell' ? await quote(USDC_MINT, BOOK[t].mint, Math.round(pos.shares * pos.px * 1e6)) : await quote(BOOK[t].mint, USDC_MINT, Math.round(pos.shares * DEC));
    let usdBack = pos.side === 'sell' ? -(pos.shares * (Number(q.inAmount) / 1e6) / (Number(q.outAmount) / DEC)) : Number(q.outAmount) / 1e6, sig = null;
    if (pos.side === 'sell') {
      // buy back exactly the shares sold: spend = shares x executable price
      const exitPx = (Number(q.inAmount) / 1e6) / (Number(q.outAmount) / DEC);
      const spend = pos.shares * exitPx;
      const qb = await quote(USDC_MINT, BOOK[t].mint, Math.round(spend * 1e6));
      if (this.live()) { const r = await swap(this.fund.wallet, qb, { outMint: BOOK[t].mint, outProgram: TOKEN_2022_PROGRAM_ID }); sig = r.sig; if (this.v) { this.v.usdc -= spend; this.v.shares[t] += Number(r.outRaw) / DEC; } }
      usdBack = -spend;
    } else if (this.live()) {
      const r = await swap(this.fund.wallet, q, { outMint: USDC_MINT, outProgram: TOKEN_PROGRAM_ID }); sig = r.sig; usdBack = Number(r.outRaw) / 1e6;
      if (this.v) { this.v.usdc += usdBack; this.v.shares[t] -= pos.shares; }
    }
    const pnl = pos.side === 'sell' ? pos.usd + usdBack : usdBack - pos.usd;
    const exitPx = pos.side === 'sell' ? -usdBack / pos.shares : usdBack / pos.shares;
    const spread = pos.side === 'sell' ? pos.shares * ((pos.px - pos.ref) - (exitPx - ref)) : pos.shares * ((exitPx - ref) - (pos.px - pos.ref));
    this.open.delete(t);
    if (this.live()) this.realisedUsd += pnl;
    this.fund.s.stockPnlUsd += pnl; this.fund.s.stockTrades += 1;
    log.info(`stock ${cfg.stockMode} CLOSE ${t}x (${reason}) $${pnl.toFixed(2)} (gap part $${spread.toFixed(2)}) · total $${this.fund.s.stockPnlUsd.toFixed(2)} / ${this.fund.s.stockTrades} trades`);
    await ledger.event('stock-close', { txs: sig ? [sig] : [], detail: { mode: cfg.stockMode, ticker: t, side: pos.side, entry_px: r2(pos.px), exit_px: r2(exitPx), ref: r2(ref), pnl_usd: r2(pnl), spread_usd: r2(spread), held_min: Math.round((Date.now() - pos.at) / 60e3), reason } });
  }

  /** Move realised stock profit into the pot as SOL. Gains: sell USDC for SOL. Losses: debit the pot at the SOL price. */
  async sweep() {
    if (!this.live() || Date.now() - this.lastSweepAt < 600e3) return;
    this.lastSweepAt = Date.now();
    const delta = this.realisedUsd - this.sweptUsd;
    if (Math.abs(delta) < cfg.stockSweepUsd) return;
    if (delta > 0) {
      const q = await quote(USDC_MINT, SOL_MINT, Math.round(delta * 1e6), 50);
      const r = await swap(this.fund.wallet, q, { outMint: SOL_MINT });
      if (this.v) this.v.usdc -= delta;
      this.sweptUsd += delta;
      await this.fund.onIncome(Number(r.outRaw) / 1e9, r.sig, 'stock-desk');
    } else {
      const px = await solUsd(); if (!px) return;
      this.sweptUsd += delta;
      await this.fund.onIncome(delta / px, null, 'stock-desk loss');
    }
  }

  view() {
    return { mode: cfg.stockMode, dry: cfg.dryRun, market_open: this.marketOpen, board: Object.values(this.board), open: [...this.open.values()].map((p) => ({ t: p.t, side: p.side, px: r2(p.px), ref: r2(p.ref), usd: r2(p.usd), gap: r2(Math.abs(p.entryGap) * 1e4) / 100, at: new Date(p.at).toISOString() })),
      realised_usd: r2(this.realisedUsd), swept_usd: r2(this.sweptUsd), clip_usd: this.clipUsd, enter_pct: cfg.stockEnterPct, inventory: this.v ?? null };
  }
}
