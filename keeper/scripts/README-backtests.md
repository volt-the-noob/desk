# Backtests

Walk-forward: at every hour the desk only sees data up to that hour. Two independent 48h windows:
A = last 48h, B = the 48h before. A strategy only counts if it profits in both.

    node scripts/bt_load.mjs --venue meteora  --offset 0  --out /tmp/w0-met.json
    node scripts/bt_load.mjs --venue meteora  --offset 48 --out /tmp/w48-met.json
    node scripts/bt_load.mjs --venue majors   --offset 0  --out /tmp/w0-maj.json
    node scripts/bt_load.mjs --venue majors   --offset 48 --out /tmp/w48-maj.json
    node scripts/bt_load.mjs --venue pumpswap --offset 0  --out /tmp/w0-ps.json    # GeckoTerminal, ~3 min (rate limit)
    node scripts/bt_load.mjs --venue pumpswap --offset 48 --out /tmp/w48-ps.json
    node scripts/bt_strategies.mjs     # 11 families + 6,480-combination grid
    node scripts/bt_report.mjs         # where the profit came from (fees vs price)

Known biases: the universe is today's top pools, so window B over-represents coins that survived (makes B look better);
hourly bars understate intraday re-centers; fee capture assumed 1.0x pool average.
