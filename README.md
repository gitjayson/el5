# el5

el5 is a read-only crypto market-structure instrument for the web and iPhone. It measures rolling seven-day Pearson correlation across a 13-asset Coinbase universe and turns that structure into an overview, focused radial radar, regime brief, diversification score, alerts, and a live price channel.

The production website is [el5.io](https://el5.io). The access code is `STATIC`.

## Product

- **ALL overview** shows BTC, ETH, SOL, and XRP together with live quotes, 24-hour change, regime, and alignment.
- **Focused radar** positions 12 peers by absolute correlation; selecting any peer promotes it to the center and recalculates the instrument around that asset.
- **Structure brief** states the important market deltas plainly: regime, tightening or loosening, average correlation, alignment, coverage, and strongest/weakest coupling.
- **Diversify view** reverses the radar and shows the neutral score `1 - |correlation|`; it does not recommend holdings or allocations.
- **In-app alerts** detect two-standard-deviation moves in completed-hour correlation history, with a 30-minute per-pair cooldown.
- **Price channel** uses EMA(20) and ATR(14), displays upper/current/lower zones, and places the live quote against boundaries calculated from completed candles.
- **Snapshot export** produces a retina PNG with an el5.io watermark and UTC timestamp.

Replay was intentionally removed. el5 reports the current structure rather than asking the user to reconstruct it from historical animation.

## Architecture

The web product has no build system, framework, server application, or runtime dependency. The interface, calculations, Coinbase client, cache, and alerts live in `dashboard.html`.

| File | Purpose |
|---|---|
| `index.html` | Client-side access gate and public links. |
| `dashboard.html` | Complete market-structure dashboard. |
| `privacy.html` | Public privacy policy. |
| `support.html` | Public support page. |
| `deploy.sh` | Static rsync deployment to el5.io. |
| `data/` and `gen_*.py` | Legacy research inputs; not required by the current dashboard. |

## Data execution

- Coinbase Exchange public endpoints; no API key or backend proxy.
- 168 completed hourly candles plus a 24-hour structure comparison window.
- Current ticker quotes are fetched separately from completed candles.
- At most three requests run concurrently; each request has a 15-second timeout.
- Bars are validated, sorted, deduplicated, and gap-checked before returns are calculated.
- Failed symbols are excluded and labeled instead of being mixed with stale values.
- A versioned local cache supports clearly labeled stale/offline fallback for up to six hours.
- Refresh runs every five minutes, pauses while hidden, and resumes when the page returns online or visible.

## Local preview

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000` and enter `STATIC`.

## Deployment

```bash
bash deploy.sh
```

The script uses `~/.ssh/pengo` and deploys the public static files to `el5user@el5.io:/home/el5user/el5.io/`.

## Security and privacy

- No market-data API secrets are used by the product.
- The gate is a lightweight client-side access screen, not a security boundary.
- Preferences, cached data, focus selection, and alert history stay in browser local storage.
- Support requests go to `support@el5.io`.
