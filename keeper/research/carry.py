import json, statistics
d = json.load(open('/tmp/hl.json')); H = d['hist']
SOLUSD = 100.8; CAP = 20 * SOLUSD
# per-coin hourly funding series
ser = {c: {int(x['time'] // 3600000): float(x['fundingRate']) for x in v} for c, v in H.items()}
now = max(max(s) for s in ser.values())
def run(win_end, K, min_apr, hold_min, spot_cost, perp_cost=0.00045):
    start = win_end - 48
    notional = CAP / 2               # half spot, half perp margin (1x short): price-neutral
    book, pnl, costs, held = {}, 0.0, 0.0, {}
    for h in range(start, win_end):
        # score on trailing 24h only
        score = {c: statistics.mean([s.get(t, 0) for t in range(h - 24, h)]) for c, s in ser.items()}
        want = [c for c, f in sorted(score.items(), key=lambda kv: -kv[1]) if f * 24 * 365 >= min_apr][:K]
        for c in list(book):
            if c not in want and h - held[c] >= hold_min:
                costs += book.pop(c) * (spot_cost + perp_cost)
        free = [c for c in want if c not in book]
        if free:
            size = notional / K
            for c in free:
                if len(book) >= K: break
                book[c] = size; held[c] = h; costs += size * (spot_cost + perp_cost)
        for c, sz in book.items(): pnl += sz * ser[c].get(h, 0)   # shorts receive positive funding
    costs += sum(book.values()) * (spot_cost + perp_cost)          # unwind at the end
    return pnl, costs, pnl - costs
print('funding carry on 20 SOL (~$%d), half spot / half 1x short perp, trailing-24h selection' % CAP)
print('%-38s %10s %10s %10s %10s' % ('config', 'A funding', 'A net', 'B funding', 'B net'))
for K in (1, 3, 6):
    for min_apr in (0.0, 0.2, 0.5):
        for spot_cost in (0.001, 0.003):
            a = run(now + 1, K, min_apr, 24, spot_cost); b = run(now + 1 - 48, K, min_apr, 24, spot_cost)
            print('%-38s %+9.2f$ %+9.2f$ %+9.2f$ %+9.2f$' % (f'top{K} minAPR {int(min_apr*100)}% spotcost {spot_cost*100:.1f}%', a[0], a[2], b[0], b[2]))
# what the best coins actually paid
print('\nhighest average funding, last 96h (APR):')
avg = sorted(((c, statistics.mean(s.values()) * 24 * 365 * 100) for c, s in ser.items()), key=lambda x: -x[1])
print('  ' + ', '.join(f'{c} {a:.0f}%' for c, a in avg[:8]))
print('  lowest: ' + ', '.join(f'{c} {a:.0f}%' for c, a in avg[-4:]))
