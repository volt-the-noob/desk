import json, urllib.request, time, statistics
def get(u, ua=False):
    for i in range(5):
        try:
            r = urllib.request.Request(u, headers={'accept': 'application/json', **({'User-Agent': 'Mozilla/5.0'} if ua else {})})
            return json.load(urllib.request.urlopen(r, timeout=30))
        except Exception: time.sleep(3 + 3 * i)
pools = {'NVDA': '49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6', 'TSLA': '8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF',
         'SPY': '4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw', 'AAPL': 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y'}
for t in ('MSTR', 'COIN', 'META', 'QQQ'):
    d = get(f'https://api.geckoterminal.com/api/v2/search/pools?query={t}x&network=solana'); time.sleep(2.5)
    c = [p for p in (d or {}).get('data', []) if p['attributes']['name'].startswith(f'{t}x / USDC')]
    if c: pools[t] = max(c, key=lambda p: float(p['attributes']['volume_usd']['h24'] or 0))['attributes']['address']
TRADE, results = 500.0, {}
for t, addr in pools.items():
    o = get(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{addr}/ohlcv/minute?aggregate=1&limit=1000&currency=usd'); time.sleep(2.5)
    y = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1m&range=1d', ua=True)
    if not o or not y: continue
    pool = {int(r[0]) // 60: (r[4], r[5]) for r in o['data']['attributes']['ohlcv_list']}   # close of minute
    q = y['chart']['result'][0]
    ref = {int(ts) // 60 + 1: c for ts, c in zip(q['timestamp'], q['indicators']['quote'][0]['close']) if c}  # yahoo 1m bar closes at start+60s
    mins = sorted(m for m in ref if m in pool)
    if len(mins) < 60: continue
    gap = [(m, pool[m][0] / ref[m] - 1, pool[m][1]) for m in mins]
    results[t] = gap
def backtest(gap, thr, cost, persist=2, base_win=60):
    pnl, trades, pos, hist = 0.0, 0, 0, []
    for i, (m, g, vol) in enumerate(gap):
        hist.append(g)
        if len(hist) < base_win: continue
        base = statistics.median(hist[-base_win:])        # the pool's usual premium, trailing only
        dev = g - base
        recent = [x - base for x in hist[-persist:]]
        if pos == 0:
            if all(x > thr for x in recent): pos, entry = -1, dev     # pool rich: sell inventory into it
            elif all(x < -thr for x in recent): pos, entry = 1, dev   # pool cheap: buy
        elif (pos == -1 and dev <= 0) or (pos == 1 and dev >= 0) or i == len(gap) - 1:
            pnl += TRADE * ((entry - dev) * (-pos) * -1 if False else (entry - dev) if pos == -1 else (dev - entry)) - TRADE * cost
            trades += 1; pos = 0
    return pnl, trades
print('today, 1-minute bars: xStock pool vs real stock, gap measured against each pool\'s trailing 60-min median premium')
for t, g in results.items():
    ds = [x for _, x, _ in g]
    print(f'  {t:5} {len(g)} min  premium median {statistics.median(ds)*100:+.3f}%  |gap| p50 {statistics.median(abs(x - statistics.median(ds)) for x in ds)*100:.3f}%  p95 {sorted(abs(x - statistics.median(ds)) for x in ds)[int(len(ds)*.95)]*100:.3f}%')
print('\nmean-reversion trades, $500 clips, close when the gap returns to the usual premium:')
for thr in (0.002, 0.004, 0.006):
    for cost in (0.0015, 0.003):
        tot = [backtest(g, thr, cost) for g in results.values()]
        print(f'  enter at {thr*100:.1f}% gap, round-trip cost {cost*100:.2f}%: {sum(n for _, n in tot):3d} trades, net ${sum(p for p, _ in tot):+8.2f} for the session')
