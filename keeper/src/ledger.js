import { createClient } from '@supabase/supabase-js';
import { cfg } from './config.js';
import { log } from './log.js';

const desk = cfg.deskName;
const memory = cfg.supabaseUrl === 'memory'; // local testing: keep the ledger in RAM, log everything
const sb = memory ? null : createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });

const must = ({ data, error }) => { if (error) throw new Error(`supabase: ${error.message}`); return data; };

const mem = { state: null, events: [], owed: new Map(), payouts: [], pools: new Map() };
const memLedger = {
  async savePool(row) { mem.pools.set(row.pool_address, { ...(mem.pools.get(row.pool_address) ?? {}), ...row }); },
  async snapshot() {},
  async openPools() { return [...mem.pools.values()].filter((r) => r.status === 'open'); },
  async loadState() { return mem.state; },
  async saveState(state) { mem.state = { ...(mem.state ?? {}), id: desk, ...state }; },
  async event(kind, e = {}) { mem.events.push({ kind, ...e }); log.info(`[ledger] ${kind} ${JSON.stringify(e.detail ?? {})}`); },
  async accrueOwed(items) { for (const it of items) mem.owed.set(it.wallet, (mem.owed.get(it.wallet) ?? 0) + it.sol); },
  async payable(min) { return [...mem.owed].filter(([, v]) => v >= min).map(([wallet, owed_sol]) => ({ wallet, owed_sol })).sort((a, b) => b.owed_sol - a.owed_sol); },
  async unpaidTotal() { return [...mem.owed.values()].reduce((s, v) => s + v, 0); },
  async markPaid(items) { for (const it of items) mem.owed.set(it.wallet, Math.max(0, (mem.owed.get(it.wallet) ?? 0) - it.sol)); },
  async recordPayout(head, items) { mem.payouts.push({ head, items }); return mem.payouts.length; },
};

const sbLedger = {
  async snapshot(row) {
    try { must(await sb.from('equity_snapshots').insert({ desk, ...row })); } catch (e) { log.warn(`snapshot failed: ${e.message}`); }
  },

  async savePool(row) {
    must(await sb.from('desk_pools').upsert({ desk, ...row }, { onConflict: 'desk,pool_address' }));
  },

  async openPools() {
    return must(await sb.from('desk_pools').select('*').eq('desk', desk).eq('status', 'open'));
  },

  async loadState() {
    const data = must(await sb.from('desk_state').select('*').eq('id', desk).maybeSingle());
    return data;
  },

  async saveState(state) {
    must(await sb.from('desk_state').upsert({ id: desk, ...state, updated_at: new Date().toISOString() }));
  },

  async event(kind, { solDelta = 0, price = null, detail = {}, txs = [] } = {}) {
    try {
      must(await sb.from('desk_events').insert({ desk, kind, sol_delta: solDelta, price, detail, txs }));
    } catch (e) {
      log.warn(`ledger event ${kind} failed: ${e.message}`);
    }
  },

  async accrueOwed(items) { // [{wallet, sol}]
    if (!items.length) return;
    for (let i = 0; i < items.length; i += 1000) {
      must(await sb.rpc('accrue_owed', { p_desk: desk, rows: items.slice(i, i + 1000) }));
    }
  },

  async payable(minSol) {
    return must(await sb.from('wallet_owed').select('wallet, owed_sol').eq('desk', desk).gte('owed_sol', minSol).order('owed_sol', { ascending: false }));
  },

  async unpaidTotal() {
    const rows = must(await sb.from('wallet_owed').select('owed_sol').eq('desk', desk).gt('owed_sol', 0));
    return rows.reduce((s, r) => s + Number(r.owed_sol), 0);
  },

  async markPaid(items) { // [{wallet, sol}]
    for (let i = 0; i < items.length; i += 1000) {
      must(await sb.rpc('mark_paid', { p_desk: desk, rows: items.slice(i, i + 1000) }));
    }
  },

  async recordPayout(head, items) {
    const p = must(await sb.from('payouts').insert({ desk, ...head }).select('id').single());
    for (let i = 0; i < items.length; i += 1000) {
      must(await sb.from('payout_items').insert(items.slice(i, i + 1000).map((it) => ({ payout_id: p.id, wallet: it.wallet, amount_sol: it.sol, tx: it.tx }))));
    }
    return p.id;
  },
};

export const ledger = memory ? memLedger : sbLedger;
