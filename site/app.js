(() => {
const C = window.DESK_CONFIG;
const $ = (id) => document.getElementById(id);
const H = { apikey: C.SUPABASE_ANON_KEY, Authorization: `Bearer ${C.SUPABASE_ANON_KEY}` };
const q = async (path) => { const r = await fetch(`${C.SUPABASE_URL}/rest/v1/${path}`, { headers: H }); if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); };
const D = encodeURIComponent(C.DESK_NAME);
const n = (v, d = 4) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
const ago = (iso) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const hms = (iso) => new Date(iso).toTimeString().slice(0, 8);
const txLink = (sig) => (sig && !sig.startsWith('dry-run') ? `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${short(sig)}</a>` : '—');
const cls = (v) => (Number(v) < 0 ? 'neg' : 'pos');
const sgn = (v, d = 4) => (Number(v) > 0 ? '+' : '') + n(v, d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let first = true, solUsd = null, lastState = null;
$('ticks').innerHTML = Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * Math.PI * 2; const r1 = i % 4 === 0 ? 118 : 124, r2 = 130; return `<line class="tick" x1="${160 + r1 * Math.cos(a)}" y1="${160 + r1 * Math.sin(a)}" x2="${160 + r2 * Math.cos(a)}" y2="${160 + r2 * Math.sin(a)}"/>`; }).join('');
const counted = new Map();
function setNum(id, value, d = 4) {
const el = $(id); if (!el || value == null || isNaN(value)) return;
const from = counted.get(id) ?? 0; counted.set(id, value);
if (reduced || !first) { el.textContent = n(value, d); return; }
const t0 = performance.now(), dur = 1200;
(function step(t) { const k = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - k, 3); el.textContent = n(from + (value - from) * e, d); if (k < 1) requestAnimationFrame(step); })(t0);
}
if (C.X_URL) { const nx = $('nav-x'); nx.href = C.X_URL; nx.hidden = false; $('foot-x').innerHTML = `<a href="${esc(C.X_URL)}" target="_blank" rel="noopener">x ↗</a>`; }
const caBtn = $('ca');
if (C.CONTRACT_ADDRESS) {
const label = () => `<b>CA</b> <span>${short(C.CONTRACT_ADDRESS)}</span> <span>copy</span>`;
caBtn.innerHTML = label(); caBtn.title = C.CONTRACT_ADDRESS;
caBtn.addEventListener('click', async () => {
try { await navigator.clipboard.writeText(C.CONTRACT_ADDRESS); } catch { prompt('Contract address', C.CONTRACT_ADDRESS); }
caBtn.classList.add('copied'); caBtn.innerHTML = '<b>CA</b> <span>copied</span>';
setTimeout(() => { caBtn.classList.remove('copied'); caBtn.innerHTML = label(); }, 1600);
});
const buy = $('buy'); buy.href = `https://pump.fun/coin/${C.CONTRACT_ADDRESS}`; buy.hidden = false;
} else { caBtn.disabled = true; }
async function solPrice() { try { const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); const j = await r.json(); solUsd = j.solana?.usd ?? null; } catch { solUsd = null; } }
let openPools = [];
async function loadState() {
const [st] = await q(`desk_state?id=eq.${D}&select=*`);
if (!st) { $('status').innerHTML = '<span class="dot off"></span>no ledger yet'; return; }
const cfg = st.config || {};
const stale = st.last_tick_at && Date.now() - Date.parse(st.last_tick_at) > 180000;
const dot = st.dry_run ? 'dry' : st.status !== 'running' || stale ? 'off' : '';
const label = st.dry_run ? 'dry run' : st.status === 'running' ? (stale ? 'stalled' : 'desk · live') : st.status;
$('status').innerHTML = `<span class="dot ${dot}"></span>${esc(label)}`;
const equity = Number(st.equity_sol);
if (st.sol_usd) solUsd = Number(st.sol_usd);
lastState = st;
setNum('aum', equity, 2);
$('aum-usd').textContent = solUsd ? `≈ $${n(equity * solUsd, 0)} · SOL at $${n(solUsd, 2)}` : '';
const usd = (v) => (solUsd && v != null ? `≈ $${n(Number(v) * solUsd, 0)}` : '');
const profit = Number(st.profit_total_sol ?? (Number(st.fees_total_sol) + Number(st.band_pnl_total_sol)));
setNum('worth', equity, 2); $('worth-usd').textContent = usd(equity);
const pe = $('profit'); setNum('profit', profit, 3); pe.className = 'v ' + cls(profit); $('profit-usd').textContent = usd(profit);
$('paid-usd').textContent = `$${n(st.paid_total_usd ?? 0, 0)} at payout prices`;
setNum('ops-paid', Number(st.ops_total_sol), 3); $('ops-usd').textContent = `$${n(st.ops_total_usd ?? 0, 0)}`;
const bbOn = Number(cfg.buyback_share_pct ?? 0) > 0 || Number(st.buyback_total_sol) > 0;
document.querySelectorAll('.figs > .bb').forEach((el) => { el.hidden = !bbOn; });
setNum('bb-sol', Number(st.buyback_total_sol ?? 0), 3); $('bb-usd').textContent = `$${n(st.buyback_total_usd ?? 0, 0)}`;
$('burned').textContent = Number(st.burned_total_tokens ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); $('burned-k').textContent = `${C.TICKER} tokens`;
$('holders').textContent = st.holders_count != null ? Number(st.holders_count).toLocaleString('en-US') : '—';
$('free-dep').textContent = `${n(st.free_sol, 1)} · ${n(st.deployed_sol, 1)}`;
const start = Number(st.start_equity_sol || 0);
const roi = start > 0 ? ((equity + Number(st.paid_total_sol || 0) + Number(st.ops_total_sol || 0) + Number(st.buyback_total_sol || 0)) / start - 1) * 100 : null;
const re = $('roi'); re.textContent = roi == null ? '—' : (roi > 0 ? '+' : '') + roi.toFixed(1) + '%'; re.className = 'v ' + cls(roi ?? 0);
setNum('income', Number(st.income_total_sol ?? 0), 3); $('income-usd').textContent = usd(Number(st.income_total_sol ?? 0));
const sp = Number(st.stock_pnl_usd ?? 0), spe = $('stock-pnl'); spe.textContent = (sp >= 0 ? '+$' : '−$') + n(Math.abs(sp), 2); spe.className = 'v ' + cls(sp);
$('stock-pnl-k').textContent = `USD · ${st.stock_trades ?? 0} trades${st.stock_mode === 'paper' ? ' · paper' : ''}`;
renderStocks(st);
renderPoolsSoon(st);
renderRisk(st);
$('roi-k').textContent = start > 0 ? `on ${n(start, 1)} SOL, incl. everything paid out` : 'since launch';
const H = cfg.holder_share_pct ?? 50, R = cfg.reserve_share_pct ?? 30, O = cfg.ops_share_pct ?? 20, B = cfg.buyback_share_pct ?? 0;
$('lede-split').textContent = H === 50 ? 'half to holders in SOL' : `${H}% to holders in SOL`;
$('lede-rest').textContent = `, ${R}% back into the book, ${O}% to OPS` + (B ? `, ${B}% to buy back and burn ${C.TICKER}` : '');
$('split-chips').innerHTML = `<span><b>${H}%</b> holders · in SOL</span><span><b>${R}%</b> reserve · the book</span><span><b>${O}%</b> OPS</span>` + (B ? `<span><b>${B}%</b> buyback · burned</span>` : '');
if (B) $('faq-trade').textContent = `Only in one way: ${B}% of every payout buys ${C.TICKER} on the open market and burns it, on the same daily clock, in one transaction you can open on Solscan. Outside that it never buys or sells the token, and it never trades to move a price.`;
const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
if ($('seat-word')) $('seat-word').textContent = cfg.max_seats ? `${words[cfg.max_seats] ?? cfg.max_seats}` : 'Three';
const hs = (cfg.holder_share_pct ?? 50) / 100;
setNum('owed', hs * Math.max(Number(st.pot_sol), 0), 4);
const interval = (cfg.payout_interval_hours ?? 24) * 3600e3;
const last = st.last_payout_at ? Date.parse(st.last_payout_at) : Date.now();
const next = st.next_payout_at ? Date.parse(st.next_payout_at) : last + interval;
const left = Math.max(0, next - Date.now());
const frac = Math.min(1, Math.max(0, 1 - left / interval));
$('prog').style.strokeDashoffset = (879.6 * (1 - frac)).toFixed(1);
$('next-payout').textContent = left <= 0 ? 'now' : `${Math.floor(left / 3600e3)}h ${String(Math.floor((left % 3600e3) / 60e3)).padStart(2, '0')}m`;
setNum('paid', Number(st.paid_total_sol), 3);
$('open').textContent = `${st.open_pools ?? 0} / ${cfg.max_pools ?? '—'}`;
setNum('fees', Number(st.fees_total_sol), 3);
const bp = $('band-pnl'); setNum('band-pnl', Number(st.band_pnl_total_sol), 3); bp.className = 'v ' + cls(st.band_pnl_total_sol);
$('foot-wallet').innerHTML = st.wallet ? `<a href="https://solscan.io/account/${esc(st.wallet)}" target="_blank" rel="noopener">desk wallet ${short(st.wallet)} ↗</a>` : '';
$('foot-token').innerHTML = st.holder_token_mint ? `<a href="https://solscan.io/token/${esc(st.holder_token_mint)}" target="_blank" rel="noopener">token ↗</a>` : '';
const cands = Array.isArray(st.candidates) ? st.candidates : [];
$('candidates').innerHTML = cands.length
? `<table><thead><tr><th>Pool</th><th>Fee÷liq 1h</th><th>24h</th><th>Liquidity</th><th>Vol 24h</th></tr></thead><tbody>` +
cands.map((c) => `<tr><td><a href="https://app.meteora.ag/dlmm/${esc(c.pool)}" target="_blank" rel="noopener">${esc(c.symbol)}</a></td><td>${n(c.fee_tvl_1h, 2)}%</td><td>${n(c.fee_tvl_24h, 1)}%</td><td>$${n(c.tvl, 0)}</td><td>$${n(c.vol24, 0)}</td></tr>`).join('') + `</tbody></table>`
: '<p class="empty">No scan yet.</p>';
}
function nextOpen() {
const d = new Date(); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30));
if (d >= t) t.setUTCDate(t.getUTCDate() + 1);
while ([0, 6].includes(t.getUTCDay())) t.setUTCDate(t.getUTCDate() + 1);
return t;
}
function dur(ms) { const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${String(m).padStart(2, '0')}m`; }
function renderStocks(st) {
const k = st.stock || {}; const mode = st.stock_mode || k.mode || 'off';
$('stk-mode').textContent = mode === 'live' ? (k.dry ? 'simulated' : 'live') : mode;
const soon = $('stk-soon'); if (mode !== 'live') { soon.hidden = false; soon.innerHTML = '<span>The stock desk goes live on day two.<br>Until then it watches every session and publishes the trades it would have made.</span><span>mode <b>paper</b></span>'; } else soon.hidden = true;
const open = !!k.market_open;
$('stk-status').innerHTML = open ? `<span class="dot"></span><span>US market open · <b>watching ${(k.board || []).length} stocks</b></span>` : `<span class="dot off"></span><span>US market closed · opens in <b>${dur(nextOpen() - Date.now())}</b> · the desk never trades against a stale price</span>`;
$('stk-book').textContent = '$' + n(st.stock_book_usd ?? 0, 0);
const rp = mode === 'live' ? Number(k.realised_usd ?? 0) : Number(st.stock_pnl_usd ?? 0); const re = $('stk-real'); re.textContent = (rp >= 0 ? '+$' : '−$') + n(Math.abs(rp), 2); re.className = 'v ' + cls(rp);
$('stk-real-k').textContent = mode === 'paper' ? 'USD · paper, not in the pot' : `USD · $${n(k.swept_usd ?? 0, 2)} moved into the pot`;
$('stk-trades').textContent = st.stock_trades ?? 0; $('stk-clip').textContent = k.clip_usd ? `$${n(k.clip_usd, 0)} per trade` : 'per trade';
$('stk-open').textContent = (k.open || []).length;
const rows = (k.board || []);
$('stk-board').innerHTML = rows.length ? rows.map((r) => {
const g = Number(r.gap || 0), w = Math.min(50, Math.abs(g) / (Number(k.enter_pct || 0.4) * 2) * 50), hot = Math.abs(g) >= Number(k.enter_pct || 0.4);
const bar = `<span class="gapbar"><i><b class="${hot ? 'hot' : ''}" style="${g >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></b></i>${g >= 0 ? '+' : ''}${n(g, 2)}%</span>`;
const desk = r.open ? `<span class="badge ${r.open}">${r.open === 'sell' ? 'sold rich' : 'bought cheap'}</span>` : `<span class="badge watch">${r.warm ? 'watching' : 'learning'}</span>`;
return `<tr><td class="t">${esc(r.t)}x</td><td>$${n(r.ref, 2)}${r.ref_age > 180 ? ' <span class="empty">closed</span>' : ''}</td><td>$${n(r.bid, 2)}</td><td>$${n(r.ask, 2)}</td><td>${r.usual >= 0 ? '+' : ''}${n(r.usual, 2)}%</td><td>${r.premium >= 0 ? '+' : ''}${n(r.premium, 2)}%</td><td>${bar}</td><td>${desk}</td></tr>`;
}).join('') : '<tr><td colspan="8" class="empty">No prices yet.</td></tr>';
}
function renderRisk(st) {
const r = st.pool_risk; const el = $('pool-risk'); if (!r || !r.calm) { el.innerHTML = ''; return; }
const cell = (name, x, note) => { const paused = x.paused_until && Date.parse(x.paused_until) > Date.now();
  return `<div><div class="k">${name} sleeve</div><div class="v">${n(x.cap_sol, x.cap_sol >= 10 ? 1 : 2)} SOL</div><div class="u">${note}</div></div>`
  + `<div><div class="k">${r.breaker_days}-day result</div><div class="v ${cls(x.result ?? 0)}">${x.result == null ? '—' : sgn(x.result, 3)}</div><div class="u">breaker at ${n(x.limit ?? -(x.cap_sol * x.breaker_pct / 100), 3)} SOL · <span class="${paused ? 'neg' : 'pos'}">${paused ? 'paused ' + dur(Date.parse(x.paused_until) - Date.now()) : 'active'}</span></div></div>`; };
const m = r.meme || {}, f = m.filters || {}, e = m.exits || {};
el.innerHTML = `<div><div class="k">working capital</div><div class="v">${n(r.budget_sol ?? 0, (r.budget_sol ?? 0) >= 10 ? 1 : 2)} SOL</div><div class="u">${r.alloc_pct}% of the treasury · rest stays in SOL</div></div>` + cell('calm', r.calm, 'verified · moved <5% · 12% floor') + cell('meme', m, `≥${(f.min_holders ?? 0).toLocaleString('en-US')} holders · organic ≥${f.min_organic ?? 0} · ${e.trail_pct ?? 0}% trailing stop · ${e.max_hold_h ?? 0}h max`);
const mc = Array.isArray(st.meme_candidates) ? st.meme_candidates : [];
$('meme-cands').innerHTML = mc.length ? `<table><thead><tr><th>Coin</th><th>Venue</th><th>Mcap</th><th>Holders</th><th>Organic</th><th>Fee÷liq 24h</th><th>Vol 24h</th></tr></thead><tbody>` + mc.map((c) => `<tr><td><a href="${c.venue === 'pumpswap' ? 'https://swap.pump.fun/?input=So11111111111111111111111111111111111111112&output=' : 'https://app.meteora.ag/dlmm/'}${esc(c.venue === 'pumpswap' ? (c.token || c.pool) : c.pool)}" target="_blank" rel="noopener">${esc(c.symbol)}</a></td><td>${c.venue === 'pumpswap' ? 'PumpSwap' : 'Meteora'}</td><td>$${n(c.mcap / 1e6, 2)}M</td><td>${Number(c.holders).toLocaleString('en-US')}</td><td>${c.organic}</td><td>${n(c.fee_tvl_24h, 1)}%</td><td>$${n(c.vol24, 0)}</td></tr>`).join('') + '</tbody></table>' : '<p class="empty">No meme scan yet.</p>';
}
function renderPoolsSoon(st) {
const el = $('pools-soon'); const at = st.pools_start_at ? Date.parse(st.pools_start_at) : null;
if (st.pools_on === false && at) { el.hidden = false; el.innerHTML = `<span>The liquidity desk opens on day two.<br>Until then the stock desk and creator fees fill the pot.</span><span>opens in <b>${dur(Math.max(0, at - Date.now()))}</b></span>`; }
else if (st.pools_on === false) { el.hidden = false; el.innerHTML = '<span>The liquidity desk is switched off for now.</span>'; }
else el.hidden = true;
}
async function loadStockTrades() {
const rows = await q(`desk_events?desk=eq.${D}&kind=eq.stock-close&order=id.desc&limit=12`);
$('stk-trades-table').innerHTML = rows.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Stock</th><th>Side</th><th>In</th><th>Out</th><th>Real</th><th>Held</th><th>P&amp;L</th></tr></thead><tbody>` + rows.map((e) => { const d = e.detail || {};
return `<tr><td>${new Date(e.ts).toLocaleString()}</td><td>${esc(d.ticker)}x</td><td>${d.side === 'sell' ? 'sold rich' : 'bought cheap'}</td><td>$${n(d.entry_px, 2)}</td><td>$${n(d.exit_px, 2)}</td><td>$${n(d.ref, 2)}</td><td>${d.held_min}m</td><td class="${cls(d.pnl_usd)}">${sgn(d.pnl_usd, 2)}</td></tr>`; }).join('') + '</tbody></table></div>'
: '<p class="empty">No stock trades yet. The desk trades during US market hours, 13:30–20:00 UTC.</p>';
}
function ticker() {
const items = openPools.length
? openPools.map((p) => { const chg = p.entry_price && p.last_price ? (Number(p.last_price) / Number(p.entry_price) - 1) * 100 : null;
return `<span class="item"><span class="sym">${esc(p.symbol)}</span><span>fees <span class="pos">${n(p.fees_sol, 3)}</span></span><span>band <span class="${cls(p.band_pnl_sol)}">${sgn(p.band_pnl_sol, 3)}</span></span><span class="${cls(chg ?? 0)}">${chg == null ? '' : (chg >= 0 ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(1) + '%'}</span><span class="dim">${n(p.capital_sol, 1)} SOL</span></span>`; })
: [`<span class="item dim">no seats taken · scanner runs every 5 minutes</span>`];
const html = items.join('');
$('lane').innerHTML = html + html; // two copies for a seamless loop
}
async function loadChart() {
const rows = await q(`equity_snapshots?desk=eq.${D}&select=ts,equity_sol,paid_total_sol&order=ts.asc&limit=1000`);
const W = 820, Hh = 300, padL = 10, padR = 70, padT = 20, padB = 26;
const defs = `<defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8A33C" stop-opacity=".35"/><stop offset="1" stop-color="#E8A33C" stop-opacity="0"/></linearGradient></defs>`;
if (rows.length < 2) { $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${Hh}">${defs}<line class="grid" x1="0" y1="${Hh - padB}" x2="${W}" y2="${Hh - padB}"/><text class="axis" x="${padL}" y="${Hh - 8}">equity history appears after the first hour</text></svg>`; return; }
const t0 = Date.parse(rows[0].ts), t1 = Date.parse(rows[rows.length - 1].ts) || t0 + 1;
const eq = rows.map((r) => Number(r.equity_sol)), pd = rows.map((r) => Number(r.paid_total_sol));
const lo = Math.min(...eq) * 0.985, hi = Math.max(...eq) * 1.01 || 1;
const phi = Math.max(...pd, 0.0001) * 1.15;
const X = (t) => padL + ((Date.parse(t) - t0) / (t1 - t0)) * (W - padL - padR);
const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (Hh - padT - padB);
const Yp = (v) => padT + (1 - v / phi) * (Hh - padT - padB);
const line = (vals, Yf) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.ts).toFixed(1)},${Yf(vals[i]).toFixed(1)}`).join(' ');
const eqPath = line(eq, Y);
const lx = X(rows[rows.length - 1].ts), ly = Y(eq[eq.length - 1]);
const area = `${eqPath} L${lx.toFixed(1)},${Hh - padB} L${X(rows[0].ts).toFixed(1)},${Hh - padB} Z`;
const d = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const gy = [0.25, 0.5, 0.75].map((f) => { const y = padT + f * (Hh - padT - padB); return `<line class="grid" x1="0" x2="${W - padR}" y1="${y}" y2="${y}"/>`; }).join('');
$('chart').innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" aria-label="Desk equity over time">${defs}${gy}<path class="area" d="${area}"/><path class="paid" d="${line(pd, Yp)}"/><path class="line" d="${eqPath}"/>
<circle class="last-ring" cx="${lx}" cy="${ly}" r="7"/><circle class="last" cx="${lx}" cy="${ly}" r="3.5"/>
<text class="axis" x="${lx + 12}" y="${ly + 4}">${n(eq[eq.length - 1], 2)}</text>
<text class="axis" x="${padL}" y="${Hh - 6}">${d(rows[0].ts)}</text><text class="axis" x="${W - padR}" y="${Hh - 6}" text-anchor="end">${d(rows[rows.length - 1].ts)}</text>
<text class="axis" x="${lx + 12}" y="${Yp(pd[pd.length - 1]) + 4}" fill="var(--cobalt-2)">paid ${n(pd[pd.length - 1], 2)}</text></svg>`;
}
let seen = new Set();
async function loadTape() {
const rows = await q(`desk_events?desk=eq.${D}&kind=neq.error&order=id.desc&limit=40`);
const list = rows.slice().reverse();
if (!list.length) return;
const fmt = (e) => {
const d = e.detail || {}; const sym = d.symbol ? `<span class="sym">${esc(d.symbol)}</span> ` : '';
const m = (k, v) => (v == null ? '' : ` · <span class="n">${k}</span> <span class="${cls(v)}">${sgn(v)}</span>`);
const K = (t, c = '') => `<span class="k ${c}">${t}</span>`;
switch (e.kind) {
case 'boot': return [K('boot'), `keeper up${d.dry_run ? ' · dry run' : ''}`];
case 'scan': return [K(d.sleeve === 'meme' ? 'scan · meme' : 'scan'), (d.candidates || []).slice(0, 5).map((c) => `${esc(c.symbol)}${c.score != null ? ` <span class="n">${n(c.score, 0)}</span>` : ''}`).join(' · ') || 'no candidates'];
case 'pool-enter': return [K('enter'), `${sym}band ${d.lower}…${d.upper} · <span class="n">capital</span> ${n(d.capital_sol, 2)} SOL`];
case 'rebalance': return [K('close'), `${sym}out of range${m('band', d.band_pnl_sol)}${m('fees', d.fees_sol)}`];
case 'rebalance-open': return [K('re-center'), `${sym}band ${d.lower}…${d.upper}`];
case 'harvest': return [K('harvest'), `${sym}${m('fees', d.fees_sol)}`];
case 'pool-exit': return [K('exit', 'bad'), `${sym}${esc(d.reason)}${m('band', d.band_pnl_sol)}${m('fees', d.fees_sol)}`];
case 'floor': return [K('floor', 'bad'), `${sym}sold ${n(d.sold_x, 0)} for ${n(d.sold_sol, 3)} SOL`];
case 'exit-sell': return [K('sell'), `${sym}inventory → ${n(d.sold_sol, 3)} SOL`];
case 'payout': return [K('payout', 'pay'), `holders <span class="pos">${n(d.holders_paid_sol, 3)}</span> SOL to ${d.wallets} wallets · ops ${n(d.ops_sol, 3)} · reserve ${n(d.reserve_sol, 3)}`];
case 'payout-skipped': return [K('payout'), `skipped · pot ${n(d.pot, 3)} SOL`];
case 'stock-open': return [K(d.side === 'sell' ? 'sell rich' : 'buy cheap'), `<span class="sym">${esc(d.ticker)}x</span> $${n(d.usd, 0)} @ $${n(d.px, 2)} · <span class="n">real</span> $${n(d.ref, 2)} · <span class="n">gap</span> ${n(d.gap_pct, 2)}% · <span class="n">${esc(d.venue || '')}</span>`];
case 'stock-close': return [K('close', Number(d.pnl_usd) >= 0 ? 'pay' : 'bad'), `<span class="sym">${esc(d.ticker)}x</span> ${esc(d.reason)} after ${d.held_min}m · <span class="${cls(d.pnl_usd)}">${sgn(d.pnl_usd, 2)} USD</span>`];
case 'stock-setup': return [K('stock desk'), `funded ${n(d.sol, 2)} SOL → $${n(d.usdc, 0)} · basket $${n(d.basket_usd, 0)} in ${(d.tickers || []).join(', ')}`];
case 'income': return [K('income', 'pay'), `${esc(d.source)} <span class="pos">+${n(d.sol, 4)} SOL</span> → pot`];
case 'buyback': return [K('buyback', 'pay'), `${n(d.sol, 3)} SOL via ${esc(d.venue || 'PumpSwap')} · burned ${Number(d.tokens_burned || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`];
case 'pools-on': return [K('pools on', 'pay'), 'liquidity desk opened'];
case 'pools-breaker': return [K('breaker', 'bad'), `${esc(d.sleeve || 'pool')} sleeve ${n(d.result_sol, 3)} SOL over the window (limit ${n(d.limit_sol, 3)}): its seats closed, paused`];
case 'fee-claim': return [K('fees', 'pay'), `creator fees distributed <span class="pos">${n(d.sol, 4)} SOL</span> · desk share ${n(d.desk_sol, 4)}`];
default: return [K(esc(e.kind)), ''];
}
};
const box = $('tape-box');
// Only ever animate rows that are actually new. Re-rendering every row on each refresh (with a stagger) left most of
// them mid-animation at opacity 0, which is what made the blotter look smeared.
const prevIds = new Set([...box.querySelectorAll('.row[data-id]')].map((el) => el.dataset.id));
const html = list.map((e, i) => { const [k, t] = fmt(e); const isNew = !first && !prevIds.has(String(e.id));
  return `<div class="row${isNew ? ' fresh' : ''}" data-id="${esc(String(e.id))}"${first ? ` style="animation-delay:${Math.min(i * 25, 700)}ms"` : ''}><span class="t">${hms(e.ts)}</span>${k}<span>${t}</span></div>`; }).join('');
box.innerHTML = html;
for (const e of list) seen.add(e.id);
box.scrollTop = box.scrollHeight;
first = false;
}

async function loadPools() {
openPools = await q(`desk_pools?desk=eq.${D}&status=eq.open&order=opened_at.desc`);
ticker();
const W = 600, cx = 30, cw = W - 60;
$('position-rows').innerHTML = openPools.length ? openPools.map((p) => {
const entry = Number(p.entry_price), lastp = Number(p.last_price || p.entry_price);
const chg = entry ? lastp / entry - 1 : 0;
const cap = Number(p.capital_sol) || 0;
const val = p.value_sol != null ? Number(p.value_sol) : null;
const pnl = p.total_pnl_sol != null ? Number(p.total_pnl_sol) : Number(p.fees_sol || 0) + Number(p.band_pnl_sol || 0);
const pnlPct = cap ? (pnl / cap) * 100 : 0;
const flPct = entry && p.floor_price ? Number(p.floor_price) / entry - 1 : -0.12;
const step = 1 + (p.bin_step ?? 50) / 10000;
const half = p.position_lower != null && p.position_upper != null ? (p.position_upper - p.position_lower) / 2 : 34;
const full = p.venue === 'pumpswap';
const bLo = full ? -1 : Math.pow(step, -half) - 1, bHi = full ? 1 : Math.pow(step, half) - 1;
const span = Math.max(0.18, Math.abs(flPct) * 1.25, Math.abs(chg) * 1.6, full ? 0.2 : Math.max(-bLo, bHi) * 1.15);
const lo = -span, hi = span;
const X = (v) => cx + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * cw;
const out = !full && (chg < bLo || chg > bHi);
const trail = p.sleeve === 'meme' && p.peak_price && entry ? (Number(p.peak_price) / entry - 1) - 0.10 : null;
const state = out ? ['out of band · re-centering', 'out'] : ['in band · earning', ''];
return `<div class="position">
<a class="name" href="${p.venue === 'pumpswap' ? 'https://swap.pump.fun/?input=So11111111111111111111111111111111111111112&output=' + esc(p.token_mint || '') : 'https://app.meteora.ag/dlmm/' + esc(p.pool_address)}" target="_blank" rel="noopener">${esc(p.symbol)}<span class="slv ${p.sleeve === 'meme' ? 'meme' : ''}">${p.sleeve === 'meme' ? 'meme' : 'calm'}</span><span class="slv ven">${full ? 'pumpswap' : 'meteora'}</span><small>${n(cap, 2)} SOL in · opened ${ago(p.opened_at)}</small></a>
<div class="pbox">
<div class="pnow"><span class="live"></span>${val != null ? `worth <b>${n(val, 3)} SOL</b>${solUsd ? ` <u>$${n(val * solUsd, 0)}</u>` : ''}` : 'valuing…'}<i class="${cls(pnl)}">${sgn(pnl, 3)} SOL · ${pnl >= 0 ? '+' : ''}${n(pnlPct, 1)}%</i></div>
<svg viewBox="0 0 ${W} 60" preserveAspectRatio="none" aria-label="${esc(p.symbol)} position">
<line class="axis" x1="${cx}" x2="${cx + cw}" y1="34" y2="34"/>
${flPct > lo ? `<rect class="floor" x="${cx}" y="24" width="${X(flPct) - cx}" height="20"/><line class="stop" x1="${X(flPct)}" x2="${X(flPct)}" y1="20" y2="48"/>` : ''}
<rect class="band ${out ? 'out' : ''}" x="${X(bLo)}" y="22" width="${X(bHi) - X(bLo)}" height="24"/>
<line class="entry" x1="${X(0)}" x2="${X(0)}" y1="18" y2="50"/>
${trail != null && trail > lo ? `<line class="stop trail" x1="${X(trail)}" x2="${X(trail)}" y1="20" y2="48"/>` : ''}
<rect class="travel ${cls(chg)}" x="${X(Math.min(0, chg))}" y="31" width="${Math.abs(X(chg) - X(0))}" height="6"/>
<text class="lbl" x="${cx}" y="12">${flPct > lo ? `stop ${(flPct * 100).toFixed(0)}%` : ''}</text>
<text class="lbl" x="${X(0)}" y="12" text-anchor="middle">entry</text>
<text class="lbl" x="${cx + cw}" y="12" text-anchor="end">${full ? 'full range' : 'band'}</text>
<circle class="now-ring" cx="${X(chg)}" cy="34" r="9"/><circle class="now" cx="${X(chg)}" cy="34" r="5"/>
<text class="now-lbl ${cls(chg)}" x="${X(chg)}" y="58" text-anchor="middle">${(chg >= 0 ? '+' : '') + (chg * 100).toFixed(1)}%</text>
</svg>
</div>
<div><div class="figs2"><div><span>fees</span><b class="pos">${n(p.fees_sol, 4)}</b></div><div><span>price</span><b class="${cls(Number(p.band_pnl_sol || 0) + Number(p.unrealised_sol || 0))}">${sgn(Number(p.band_pnl_sol || 0) + Number(p.unrealised_sol || 0), 4)}</b></div></div>
<div class="state ${state[1]}" style="margin-top:8px">${state[0]}</div></div>
</div>`;
}).join('') : (lastState && lastState.pools_on === false ? '' : '<p class="empty" style="padding:18px 0">No seats taken. The desk opens seats on its next scan when it has capital to deploy.</p>');
const closed = await q(`desk_pools?desk=eq.${D}&status=eq.closed&order=closed_at.desc&limit=8`);
$('closed').innerHTML = closed.length
? `<table><thead><tr><th>Pool</th><th>Why</th><th>Fees</th><th>Band</th><th>Net</th><th>Held</th></tr></thead><tbody>` +
closed.map((p) => { const net = Number(p.fees_sol) + Number(p.band_pnl_sol); const held = p.opened_at && p.closed_at ? Math.round((Date.parse(p.closed_at) - Date.parse(p.opened_at)) / 3600e3) : null;
return `<tr><td>${esc(p.symbol)}</td><td>${esc(p.exit_reason ?? '—')}</td><td class="pos">${n(p.fees_sol, 3)}</td><td class="${cls(p.band_pnl_sol)}">${n(p.band_pnl_sol, 3)}</td><td class="${cls(net)}">${sgn(net, 3)}</td><td>${held == null ? '—' : held + 'h'}</td></tr>`; }).join('') + `</tbody></table>`
: '<p class="empty">Nothing closed yet.</p>';
}
async function loadDaily() {
const rows = await q(`daily_results?desk=eq.${D}&order=day.desc&limit=14`);
$('daily').innerHTML = rows.length
? `<table><thead><tr><th>Day</th><th>Fees</th><th>Band</th><th>Stocks $</th><th>Holders</th><th>OPS</th><th>Buyback</th><th>In/out</th></tr></thead><tbody>` +
rows.map((r) => `<tr><td>${r.day}</td><td class="pos">${n(r.fees_sol, 3)}</td><td class="${cls(r.band_pnl_sol)}">${n(r.band_pnl_sol, 3)}</td><td class="${cls(r.stock_pnl_usd)}">${sgn(r.stock_pnl_usd, 2)}</td><td>${n(r.paid_sol, 3)}</td><td>${n(r.ops_sol, 3)}</td><td>${n(r.buyback_sol, 3)}</td><td>${r.pools_entered}/${r.pools_exited}</td></tr>`).join('') + `</tbody></table>`
: '<p class="empty">Nothing booked yet.</p>';
}
async function loadPayouts() {
const rows = await q(`payouts?desk=eq.${D}&order=ts.desc&limit=14`);
$('payout-table').innerHTML = rows.length
? `<table><thead><tr><th>When</th><th>Holders SOL</th><th>OPS SOL</th><th>Wallets</th><th>Tx</th></tr></thead><tbody>` +
rows.map((r) => `<tr><td>${new Date(r.ts).toLocaleString()}${r.dry_run ? ' · sim' : ''}</td><td>${n(r.total_sol)}</td><td>${n(r.ops_sol)}</td><td>${r.wallets}</td><td>${r.tx_count}</td></tr>`).join('') + `</tbody></table>`
: '<p class="empty">No payouts yet. The first goes out at the end of the first 24h with a positive pot.</p>';
}
async function rpc(method, params) {
const r = await fetch(C.RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function tokenBalance(owner, mint) {
const res = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
return res.value.reduce((a, acc) => a + Number(acc.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}
$('lookup').addEventListener('submit', async (e) => {
e.preventDefault();
const w = $('lookup-wallet').value.trim();
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) { $('lookup-out').innerHTML = '<p class="empty">That doesn’t look like a Solana address.</p>'; return; }
$('lookup-out').innerHTML = '<p class="empty">Reading chain and ledger…</p>';
const st = lastState || {};
const cfg = st.config || {};
const mint = C.CONTRACT_ADDRESS || st.holder_token_mint;
const usdF = (v) => (solUsd ? `≈ $${n(v * solUsd, 2)}` : '');
try {
const [[owed], [rw], items, bal] = await Promise.all([
q(`wallet_owed?desk=eq.${D}&wallet=eq.${w}&select=owed_sol,paid_sol`),
q(`wallet_rewards?desk=eq.${D}&wallet=eq.${w}&select=received_sol,received_usd,payouts,last_paid_at`),
q(`payout_items?wallet=eq.${w}&select=amount_sol,tx,payouts(ts,sol_usd,dry_run)&order=id.desc&limit=30`),
mint ? tokenBalance(w, mint).catch(() => null) : Promise.resolve(null),
]);
const supply = Number(st.eligible_supply || 0);
const share = bal != null && supply > 0 ? bal / supply : null;
const potHolders = (Number(cfg.holder_share_pct ?? 50) / 100) * Math.max(Number(st.pot_sol || 0), 0);
const nextEst = share != null ? share * potHolders : null;
const pending = Number(owed?.owed_sol || 0);
const receivedSol = Number(rw?.received_sol || 0), receivedUsd = Number(rw?.received_usd || 0);
const left = st.next_payout_at ? Math.max(0, Date.parse(st.next_payout_at) - Date.now()) : null;
const inH = left == null ? '' : `in ${Math.floor(left / 3600e3)}h ${String(Math.floor((left % 3600e3) / 60e3)).padStart(2, '0')}m`;
const dust = Number(cfg.min_payout_sol ?? 0.002);
let html = `<div class="wgrid">
<div><div class="k">${esc(C.TICKER)} held</div><div class="v">${bal == null ? '—' : bal.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div><div class="u">${share != null ? (share * 100).toFixed(share < 0.0001 ? 5 : 3) + '% of eligible supply' : mint ? 'balance unavailable' : 'token not live yet'}</div></div>
<div><div class="k">next payout, estimated</div><div class="v pos">${nextEst == null ? '—' : n(nextEst + pending, 5)}</div><div class="u">SOL ${inH} ${nextEst != null ? usdF(nextEst + pending) : ''}</div></div>
<div><div class="k">pending, accrued</div><div class="v">${n(pending, 5)}</div><div class="u">sent once ≥ ${n(dust, 3)} SOL</div></div>
<div><div class="k">total received</div><div class="v">${n(receivedSol, 4)}</div><div class="u">SOL · $${n(receivedUsd, 2)} at payout prices</div></div>
<div><div class="k">total rewards</div><div class="v">${n(receivedSol + pending, 4)}</div><div class="u">received + pending ${usdF(receivedSol + pending)}</div></div>
<div><div class="k">payouts</div><div class="v">${rw?.payouts ?? 0}</div><div class="u">${rw?.last_paid_at ? 'last ' + ago(rw.last_paid_at) : 'none yet'}</div></div>
</div>`;
html += `<p class="note">The estimate is your share of eligible supply × the holders’ share of the pot right now. It moves with the pot until the clock hits zero, and it counts tokens in wallets you control (exchange and pool balances don’t count). Hold through the snapshot to be included.</p>`;
const real = items.filter((it) => !it.payouts?.dry_run);
if (real.length) html += `<div class="scroll"><table><thead><tr><th>When</th><th>SOL</th><th>USD then</th><th>Tx</th></tr></thead><tbody>` + real.map((it) => `<tr><td>${it.payouts ? new Date(it.payouts.ts).toLocaleString() : '—'}</td><td>${n(it.amount_sol, 5)}</td><td>$${n(Number(it.amount_sol) * Number(it.payouts?.sol_usd || 0), 2)}</td><td>${txLink(it.tx)}</td></tr>`).join('') + `</tbody></table></div>`;
$('lookup-out').innerHTML = html;
} catch (err) { $('lookup-out').innerHTML = `<p class="empty">Lookup failed: ${esc(err.message)}</p>`; }
});
async function refresh() {
try { await Promise.all([loadState(), loadTape(), loadPools(), loadDaily(), loadPayouts(), loadStockTrades()]); if (first) await loadChart(); }
catch (e) { $('status').innerHTML = `<span class="dot off"></span>ledger unreachable`; console.warn(e); }
first = false;
}
solPrice().then(refresh);
setInterval(refresh, C.REFRESH_MS);
setInterval(solPrice, 300000);
})();
