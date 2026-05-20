# el5 — Project Handoff

## What it is

el5 is a cyberpunk-styled crypto correlation radar dashboard. It visualizes BTC's rolling 7-day Pearson correlation against 12 altcoins on a radial SVG display, with live data from Coinbase. Lives at **el5.io**, gate code `STATIC`.

## Repo

- **GitHub:** `github.com/gitjayson/el5` (private)
- **Branch:** `main`
- **Latest commit:** `v0.2` — full feature set

## Architecture

Single-file vanilla JS dashboard — no build system, no framework, no dependencies. Everything is in `dashboard.html`.

### Files

| File | Purpose |
|---|---|
| `dashboard.html` | The entire dashboard (~2100 lines). All features, CSS, JS in one file. |
| `deploy.sh` | rsync to el5.io via SSH key `~/.ssh/pengo`. Excludes dev files. |
| `gen_replay.py` | Generates `data/replay.json` from spike CSVs (offline, not needed at runtime). |
| `gen_macro.py` | Generates `data/macro.json` from Massive API (currently unused — macro feature was removed). |
| `data/replay.json` | Pre-computed replay data (2008 frames, ~700KB). Shipped to prod. |
| `data/macro.json` | Generated macro data. Not shipped (feature removed). |

### Data flow

- **Live:** Browser fetches hourly candles directly from Coinbase Exchange public API (`api.exchange.coinbase.com`). No auth needed. Polls every 5 minutes.
- **Replay:** Loads `/data/replay.json` (pre-generated from local CSVs, served statically).

## Features (v0.2)

1. **Correlation Radar** — 12 alt hexagons positioned by |correlation| to BTC. High correlation = close to center. Green = 24h up, red = 24h down. Dashed border = inverse correlation.

2. **Decorrelation Alerts** — 2σ statistical deviation detection on rolling correlation history. On-screen banner + Web Audio chime. localStorage persistence. Cooldown: 30 min per token.

3. **Regime Detection** — Classifies market into HERD / PANIC / ROTATION / DRIFT based on average |corr| and directional consensus. Displayed below BTC in the focus hex.

4. **Anti-Radar (Diversify View)** — Toggle flips the radar: best diversifiers (low |corr|) move to center. Shows inverse-vol-weighted portfolio allocation percentages.

5. **Historical Replay** — Plays back correlation history from `replay.json`. Scrub bar, play/pause, speed control (1×/2×/4×/8×), keyboard shortcuts (Space, arrows, Escape).

6. **Volatility-Adjusted Hexes** — Hex size scales by `peer_vol / btc_vol` (clamped 0.6×–1.8×). Stroke weight scales proportionally. Bigger hex = more volatile than BTC.

7. **Dynamic Focus Hex** — BTC center hex changes color: white (#e8e8ff) when BTC 24h is up, magenta (#ff10f0) when down. Shows confirmation percentage (e.g. "83% ▲").

8. **BTC Price Channel** — Keltner-style strip below the radar: EMA(20) ± 2×ATR(14). Three stacked bands (upper/current/lower) with 24h price polyline. Price dot floats into breakout band on breakout.

9. **Snapshot Export** — SNAP button exports the radar SVG as a 2× retina PNG with el5.io watermark and UTC timestamp. Works in all view modes.

## Key constants and tunables

```
PEERS = ["ETH","SOL","BCH","XRP","ADA","AVAX","DOGE","DOT","LINK","ATOM","NEAR","LTC"]
FOCUS = "BTC"
HOURS = 168 (7-day window)
GRANULARITY = 3600 (1h candles)
POLL_MS = 300000 (5 min refresh)
ALERT_SIGMA = 2
ALERT_COOLDOWN_MS = 1800000 (30 min)
PEER_HEX_R = 26 (base hex radius before vol scaling)
REGIME_CORR_TIGHT = 0.65
REGIME_CORR_LOOSE = 0.45
```

## Deployment

```bash
cd ~/Documents/claude/el5
bash deploy.sh
```

Rsyncs to `el5user@el5.io:/home/el5user/el5.io/` via `~/.ssh/pengo`. The deploy script excludes gen scripts, Python files, and dev artifacts. Only ships `dashboard.html`, `data/replay.json`, and static assets.

## Secrets

- `../secrets.json` contains `MASSIVE_API_KEY` — only used by `gen_macro.py` (currently inactive). Never committed, never exposed client-side.
- No API keys are needed for the live dashboard — Coinbase Exchange API is public.

## Forking notes

- The entire app is `dashboard.html`. Fork it, change the tickers, restyle — it's self-contained.
- Coinbase API is unauthenticated and rate-limited. The 120ms delay between fetches and 5-min poll interval keep it well within limits.
- The gate code (`STATIC`) is checked client-side via SHA-256 hash. Change the hash in the HTML to set a new code.
- `replay.json` is optional — the replay button gracefully degrades if the file is missing (falls back to computing from live Coinbase data, though with fewer frames).
