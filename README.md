# el5 — bootstrap

Sister-product workspace to HackTrader. Same radial-correlation visualization, applied to crypto tokens with crypto-specific dimensions (24/7 trading, volume weighting, time-of-day patterns, weekend effects, stablecoin proximity).

This bootstrap folder currently contains only the **viability spike** — a Python script that fetches 12 months of hourly BTC + 12-alt klines from Binance, computes rolling 30-day Pearson correlations, and reports whether the radar peer-spread is wide enough for the visualization to carry information on this asset class. If the spike's verdict comes back STRONG or MARGINAL, the next step is forking HackTrader's UI shell and pointing it at the crypto data path. If it comes back PANCAKE, the radial encoding doesn't add information for crypto and we'd need a different visual primitive.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 spike.py
```

First run: ~2 minutes (mostly Binance API rate-limit sleeps). Subsequent runs with `--skip-fetch` are seconds.

Outputs land in:

- `data/{SYMBOL}_1h.csv` — raw klines per token (BTC + 12 alts)
- `data/correlations_30d.csv` — wide table of rolling Pearson correlations vs BTC
- `results/summary.md` — verdict + per-alt stats
- `results/spread_histogram.png` — distribution of all pairwise correlations
- `results/sample_radial.png` — three radial layouts at recent timestamps

## Verdict thresholds

The script reports a basket spread = max correlation − min correlation across all 12 alts at each timestamp. Median basket spread determines the verdict:

| Spread | Verdict | Action |
|---|---|---|
| >= 0.30 | Strong spread | Build the crypto dashboard — radar reads as a distribution |
| >= 0.15 | Marginal | Build with a curated lower-correlation basket, or with volume weighting to break ties |
| <  0.15 | Pancake | Radial encoding adds no info — pick a different visual primitive |

## Peer basket (initial)

BTC focus + 12 alts: ETH, SOL, BNB, XRP, ADA, AVAX, DOGE, DOT, LINK, ATOM, NEAR, LTC.

Picked for: top-12-by-cap excluding stablecoins and BTC; mix of L1s (SOL, AVAX, NEAR, ATOM, ADA, DOT), L2-adjacent (LINK), payment tokens (DOGE, LTC, XRP), and exchange tokens (BNB). If the spike's verdict is marginal, try swapping in lower-correlation candidates like XLM, BCH, ETC, or longer-tail tokens with genuinely different beta profiles to BTC.

## Storage architecture (for after the spike)

Two paths if we build out:

1. **Share HackTrader's Redis** under a `ht:crypto:*` prefix. Pros: zero infra duplication, easier ops. Cons: tighter coupling between products; a Redis outage takes both down.
2. **Run a separate Redis instance** (or use Redis DB 1 on the same host while keeping HackTrader on DB 0). Pros: clean isolation, can scale and tune independently. Cons: two Redis to monitor.

For the spike, results are written to local CSVs only. The architectural decision happens after the verdict comes back — if the viz is viable, we'll spec it then.

## Why a separate workspace at all?

Code reuse with HackTrader is significant (radar, focus-peer architecture, channel chart, Stripe wiring, auth) but the product positioning, marketing surface, data pipeline (Binance vs Massive), and ops model (24/7 vs market-hours) all differ. Putting el5 in its own workspace keeps the boundaries clean and avoids dashboard-mode-toggle complexity in HackTrader. If we later decide a unified product is better, merging is cheaper than splitting.

## Next steps after the spike

If the verdict is STRONG or MARGINAL:

1. Fork the HackTrader UI shell into `el5/dashboard.php` (or rewrite the relevant pieces as static HTML if we go SSR-light)
2. Stand up a crypto data refresher daemon analogous to `market_data_refresher.py` but pointed at Binance, with 24/7 cadence (no market-state classification needed)
3. Build the crypto-specific widgets discussed in chat:
   - Volume-weighted correlation radius
   - Time-of-day session band on the channel chart
   - Weekend/weekday split metric
   - Stablecoin-proximity ring (how many alts are anchored to USDT/USDC right now)
4. Decide on storage architecture (see above)
5. File a continuation-in-part on the HackTrader provisional patent that explicitly covers crypto asset-class and these crypto-specific visual dimensions

If PANCAKE: don't build the crypto radar. Use the spike's data to design a different visual that does carry information about peer structure in a high-correlation regime — probably something like "rank-by-deviation-from-BTC" or "relative-strength fan" instead of polar coordinates.
