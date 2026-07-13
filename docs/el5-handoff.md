# el5 Project Handoff

## Current state

el5 is a production static web dashboard at [el5.io](https://el5.io) and the source experience for the separate `gitjayson/el5ios` iPhone project. The web repository is `gitjayson/el5` on `main`.

The product is a current-state market-structure instrument. Replay and portfolio-allocation language have been removed.

## Runtime

- Single-file vanilla JavaScript dashboard in `dashboard.html`.
- Coinbase Exchange public candle and ticker endpoints; no credentials.
- BTC, ETH, SOL, and XRP are switchable focus assets.
- The universe is BTC, ETH, SOL, BCH, XRP, ADA, AVAX, DOGE, DOT, LINK, ATOM, NEAR, and LTC.
- Seven-day rolling Pearson correlation uses completed, timestamp-aligned hourly candles.
- Live quotes update the displayed price and channel position without contaminating completed-candle statistics.
- Refresh cadence is five minutes with bounded concurrency, request timeouts, visibility/online recovery, and versioned cache fallback.

## Primary interface

1. ALL overview with live prices, 24-hour moves, regime, and alignment.
2. Focus radar with correlation, direction, volatility-scaled peers, and detail sheets.
3. Plain-language STRUCTURE panel with current deltas, coverage, and as-of time.
4. DIVERSIFY mode using the neutral score `1 - |correlation|`.
5. In-app two-sigma decorrelation alerts based on completed hourly observations.
6. EMA/ATR price channel with live quote placement.
7. Browser and native snapshot export.

## Public pages

- `index.html`: access gate, privacy/support links, and dashboard entry.
- `privacy.html`: App Store-compatible privacy policy.
- `support.html`: public support URL using `support@el5.io`.

## Deployment

```bash
cd /Users/jay/space/el5-current
bash deploy.sh
```

Deployment uses `~/.ssh/pengo` and rsyncs public files to `el5user@el5.io:/home/el5user/el5.io/`. Development scripts, repository metadata, docs, and inactive macro data are excluded.

## Important notes

- Access code `STATIC` is represented by a SHA-256 hash in `index.html`.
- The browser fetches Coinbase directly, so Coinbase availability and browser CORS behavior remain external dependencies.
- `data/replay.json` and the generator scripts are retained as research artifacts but are not used by the current runtime.
- Keep web and iPhone projects separate. Shared dashboard changes should be ported deliberately and tested in both browser and `WKWebView` surfaces.
