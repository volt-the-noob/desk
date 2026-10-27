import json, urllib.request, time, statistics
def get(u, ua=False):
    for i in range(5):
        try:
            r = urllib.request.Request(u, headers={'accept': 'application/json', **({'User-Agent': 'Mozilla/5.0'} if ua else {})})
            return json.load(urllib.request.urlopen(r, timeout=30))
        except Exception as e: time.sleep(3 + 3 * i)
pools = {  # most liquid USDC pool per stock (from the search above + a few more tickers)
  'NVDA': '49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6', 'TSLA': '8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF',
  'SPY': '4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw', 'AAPL': 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y',
}
for t in ('MSTR', 'COIN', 'QQQ', 'META', 'GOOGL', 'AMZN'):
    d = get(f'https://api.geckoterminal.com/api/v2/search/pools?query={t}x&network=solana'); time.sleep(2.5)
    c = [p for p in (d or {}).get('data', []) if p['attributes']['name'].startswith(f'{t}x / USDC')]
    if c: pools[t] = max(c, key=lambda p: float(p['attributes']['volume_usd']['h24'] or 0))['attributes']['address']
res = {}
for t, addr in pools.items():
    o = get(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{addr}/ohlcv/hour?aggregate=1&limit=120&currency=usd'); time.sleep(2.5)
    y = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1h&range=5d', ua=True)
    if not o or not y: continue
    pool = {int(r[0]) // 3600 * 3600: (r[4], r[5]) for r in o['data']['attributes']['ohlcv_list']}
    q = y['chart']['result'][0]; ts = q['timestamp']; cl = q['indicators']['quote'][0]['close']
    # yahoo hourly bars are stamped at bar start (e.g. 13:30 UTC); compare the pool's close of the hour containing the ref bar's end
    pairs = []
    for t0, c in zip(ts, cl):
        if c is None: continue
        h = (t0 + 3600) // 3600 * 3600 - 3600
        if h in pool and pool[h][0]: pairs.append((h, pool[h][0] / c - 1, pool[h][1]))
    res[t] = pairs
print('market-hours dislocation: xStock pool close vs real stock, hourly, last ~5 sessions')
print('%-6s %5s %8s %8s %8s %10s' % ('stock', 'hours', 'mean', 'median|d|', 'max|d|', 'pool vol/h'))
for t, p in res.items():
    if not p: continue
    ds = [d for _, d, _ in p]
    print('%-6s %5d %+7.3f%% %7.3f%% %7.3f%% %9.0f$' % (t, len(p), statistics.mean(ds) * 100, statistics.median(abs(d) for d in ds) * 100, max(abs(d) for d in ds) * 100, statistics.mean(v for *_, v in p)))
# AA-v1 style: hold inventory, sell into premiums / buy discounts beyond a threshold; size per trade capped at 5% of that hour's pool volume
print('\nprofit if every hourly gap beyond the cost threshold were traded and closed back at the reference (upper bound):')
for cost in (0.0015, 0.003, 0.006):
    tot, n = 0.0, 0
    for t, p in res.items():
        for h, d, vol in p:
            edge = abs(d) - cost
            if edge > 0: size = min(500, 0.05 * vol); tot += size * edge; n += 1
    print(f'  round-trip cost {cost*100:.2f}%: {n} trades, ${tot:.2f} over ~5 sessions → ~${tot/5:.2f}/session')
