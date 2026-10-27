import json, urllib.request, time
def post(body):
    r = urllib.request.Request('https://api.hyperliquid.xyz/info', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=30))
meta, ctx = post({'type': 'metaAndAssetCtxs'})
rows = []
for a, c in zip(meta['universe'], ctx):
    if a.get('isDelisted'): continue
    rows.append((a['name'], float(c['funding']), float(c['dayNtlVlm']), float(c['openInterest']) * float(c['markPx'])))
rows.sort(key=lambda r: -r[1])
print('perps:', len(rows))
print('top current funding (hourly rate, APR, day volume $M, OI $M):')
for n, f, v, oi in rows[:15]: print(f'  {n:10} {f*100:.4f}%/h  {f*24*365*100:7.0f}% APR  vol {v/1e6:7.1f}  OI {oi/1e6:6.1f}')
sol = ['SOL','JUP','WIF','kBONK','POPCAT','FARTCOIN','PUMP','PENGU','TRUMP','JTO','RAY','MEW','GOAT','MOODENG','PNUT','AI16Z','ZEREBRO','GRIFFAIN','BOME','kPEPE','W','PYTH','DRIFT','ORCA','MELANIA','CHILLGUY','USELESS','SPX','TNSR','IO','HNT','RENDER']
names = {r[0] for r in rows}
have = [s for s in sol if s in names]
print('Solana-spot coins with HL perps:', len(have), have)
start = int((time.time() - 100*3600) * 1000)
out = {}
for s in have:
    out[s] = post({'type': 'fundingHistory', 'coin': s, 'startTime': start})
    time.sleep(0.15)
json.dump({'rows': rows, 'hist': out}, open('/tmp/hl.json', 'w'))
print('hours of history per coin:', {k: len(v) for k, v in list(out.items())[:6]})
