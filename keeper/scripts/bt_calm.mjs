import { sim, W } from './bt_core.mjs';
const base = { venues: ['meteora'], recenter: true, side: 'both', floor: 0.12, rotate: 6, capture: 1.0, min1h: 0, bins: 20 };
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
console.log('rule (trailing 24h data only)                 A last 48h      B prior 48h');
for (const [name, c] of [
  ['old: highest raw fees', { ...base, min1h: 0.3, maxRange: 0, floor: 0.35, rotate: 3 }],
  ['calm only: 24h range < 1.10x', { ...base, maxRange: 1.10 }],
  ['calm only: 24h range < 1.05x', { ...base, maxRange: 1.05 }],
  ['calm only: 24h range < 1.03x', { ...base, maxRange: 1.03 }],
  ['calm < 1.05x, wide band', { ...base, maxRange: 1.05, bins: 40 }],
  ['calm < 1.05x, 4 seats max', { ...base, maxRange: 1.05, maxSeats: 4 }],
]) { const a = sim(W.A, c), b = sim(W.B, c); console.log(`${name.padEnd(45)} ${(f(a.ret) + '%').padStart(8)} (fees ${a.fees.toFixed(2)})   ${(f(b.ret) + '%').padStart(8)} (fees ${b.fees.toFixed(2)})`); }
