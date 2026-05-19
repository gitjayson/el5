#!/usr/bin/env python3
"""
gen_macro.py — Fetch equity/commodity data from Massive API, compute
correlations against BTC (from Coinbase), and write data/macro.json.

Reads MASSIVE_API_KEY from ../secrets.json (never committed).

Output format:
{
  "tickers": ["GLD", "TLT", "QQQ", "SPY", "UUP", "WTI", "MSTR"],
  "generated": "2026-05-19T12:00:00Z",
  "current": {
    "corr": [0.12, -0.05, ...],    // current 7-day Pearson per ticker
    "bias": [0.003, -0.01, ...]    // 24h change per ticker
  },
  "frames": [
    {
      "t": "2025-06-18T08:00:00Z",
      "corr": [0.12, ...],
      "bias": [0.003, ...]
    },
    ...
  ]
}

Usage:
    python3 gen_macro.py              # generate data/macro.json
    python3 gen_macro.py --current    # only generate "current" snapshot (faster)
"""

import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"

MACRO_TICKERS = ["GLD", "TLT", "QQQ", "SPY", "UUP", "WTI", "MSTR"]
COINBASE = "https://api.exchange.coinbase.com/products"
BTC_HOURS = 168 * 5  # 5 weeks of hourly data for rolling windows
USER_AGENT = "el5/1.0"  # Coinbase blocks default Python urllib agent

# ── Secrets ──────────────────────────────────────────

def load_api_key():
    """Load MASSIVE_API_KEY from ../secrets.json or ./secrets.json."""
    candidates = [
        SCRIPT_DIR.parent / "secrets.json",
        SCRIPT_DIR / "secrets.json",
    ]
    for path in candidates:
        if path.exists():
            try:
                with open(path) as f:
                    secrets = json.load(f)
                key = secrets.get("MASSIVE_API_KEY")
                if key:
                    print(f"  API key loaded from {path}")
                    return key
            except Exception as e:
                print(f"  Warning: could not read {path}: {e}")
    print("ERROR: No MASSIVE_API_KEY found in secrets.json", file=sys.stderr)
    sys.exit(1)


# ── Massive API ──────────────────────────────────────

def fetch_massive_candles(ticker, api_key, hours=840):
    """Fetch hourly candles from Massive for an equity/commodity ticker."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    from_date = start.strftime("%Y-%m-%d")
    to_date = end.strftime("%Y-%m-%d")

    url = (
        f"https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/hour"
        f"/{from_date}/{to_date}"
        f"?adjusted=true&sort=asc&limit=50000&apiKey={api_key}"
    )

    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  ERROR fetching {ticker}: {e}")
        return None

    if data.get("status") == "ERROR" or data.get("error"):
        print(f"  ERROR for {ticker}: {data.get('error') or data.get('message')}")
        return None

    results = data.get("results") or []
    if not results:
        print(f"  WARNING: no results for {ticker}")
        return None

    candles = []
    for entry in results:
        t_ms = entry.get("t")
        if t_ms is None:
            continue
        candles.append({
            "t": int(t_ms / 1000),  # Unix seconds
            "close": entry.get("c"),
        })

    # Sort ascending by timestamp
    candles.sort(key=lambda c: c["t"])
    return candles


# ── Coinbase BTC ─────────────────────────────────────

def fetch_btc_candles(hours=840):
    """Fetch BTC hourly candles from Coinbase (chunked, 300 per request)."""
    all_candles = []
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    chunk_hours = 290  # stay under 300 limit

    cursor = start
    while cursor < end:
        chunk_end = min(cursor + timedelta(hours=chunk_hours), end)
        url = (
            f"{COINBASE}/BTC-USD/candles"
            f"?granularity=3600"
            f"&start={cursor.isoformat()}"
            f"&end={chunk_end.isoformat()}"
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                rows = json.loads(resp.read())
            for row in rows:
                all_candles.append({"t": row[0], "close": row[4]})
        except Exception as e:
            print(f"  WARNING: BTC chunk fetch error: {e}")

        cursor = chunk_end
        time.sleep(0.15)

    # Deduplicate and sort
    seen = set()
    unique = []
    for c in all_candles:
        if c["t"] not in seen:
            seen.add(c["t"])
            unique.append(c)
    unique.sort(key=lambda c: c["t"])
    return unique


# ── Correlation math ─────────────────────────────────

def log_returns(candles):
    """Compute log returns from a list of {t, close} dicts."""
    rets = []
    for i in range(1, len(candles)):
        prev, curr = candles[i - 1]["close"], candles[i]["close"]
        if prev and curr and prev > 0 and curr > 0:
            rets.append({"t": candles[i]["t"], "r": math.log(curr / prev)})
    return rets


def pearson(xs, ys):
    """Pearson correlation coefficient."""
    n = min(len(xs), len(ys))
    if n < 10:
        return None
    sx = sum(xs[:n])
    sy = sum(ys[:n])
    mx, my = sx / n, sy / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = sum((xs[i] - mx) ** 2 for i in range(n))
    dy = sum((ys[i] - my) ** 2 for i in range(n))
    if dx == 0 or dy == 0:
        return None
    return num / math.sqrt(dx * dy)


def compute_rolling_correlation(btc_rets, macro_rets, window=168):
    """Compute rolling Pearson over aligned log returns."""
    btc_map = {r["t"]: r["r"] for r in btc_rets}

    # Align timestamps
    aligned = []
    for r in macro_rets:
        if r["t"] in btc_map:
            aligned.append({"t": r["t"], "btc": btc_map[r["t"]], "macro": r["r"]})

    # Rolling correlation
    results = []
    for i in range(window, len(aligned)):
        w = aligned[i - window:i]
        xs = [p["btc"] for p in w]
        ys = [p["macro"] for p in w]
        corr = pearson(xs, ys)
        results.append({"t": aligned[i]["t"], "corr": corr})

    return results


def change_24h(candles):
    """Compute 24h percentage change from the most recent candle."""
    if len(candles) < 25:
        return None
    curr = candles[-1]["close"]
    prev = candles[-25]["close"]  # ~24h back in hourly candles
    if not prev or prev <= 0:
        return None
    return (curr - prev) / prev


# ── Main ─────────────────────────────────────────────

def main():
    current_only = "--current" in sys.argv

    print("==> gen_macro.py")
    api_key = load_api_key()

    # Fetch BTC
    print("Fetching BTC from Coinbase...")
    btc_candles = fetch_btc_candles()
    print(f"  {len(btc_candles)} BTC candles")
    if len(btc_candles) < 168:
        print("ERROR: Not enough BTC data", file=sys.stderr)
        sys.exit(1)
    btc_rets = log_returns(btc_candles)

    # Fetch macro tickers
    macro_data = {}  # ticker -> candles
    for ticker in MACRO_TICKERS:
        print(f"Fetching {ticker} from Massive...")
        candles = fetch_massive_candles(ticker, api_key)
        if candles and len(candles) >= 48:
            macro_data[ticker] = candles
            print(f"  {len(candles)} candles")
        else:
            print(f"  SKIPPED (insufficient data)")
        time.sleep(0.2)  # be polite

    # Compute current snapshot
    print("Computing correlations...")
    current_corrs = []
    current_biases = []

    for ticker in MACRO_TICKERS:
        candles = macro_data.get(ticker)
        if not candles:
            current_corrs.append(None)
            current_biases.append(None)
            continue

        macro_rets = log_returns(candles)
        # Use last 168 hours for current correlation
        btc_map = {r["t"]: r["r"] for r in btc_rets}
        xs, ys = [], []
        for r in macro_rets[-168:]:
            if r["t"] in btc_map:
                xs.append(btc_map[r["t"]])
                ys.append(r["r"])

        corr = pearson(xs, ys)
        bias = change_24h(candles)

        current_corrs.append(round(corr, 4) if corr is not None else None)
        current_biases.append(round(bias, 5) if bias is not None else None)
        corr_s = f"{corr:.4f}" if corr is not None else "N/A"
        bias_s = f"{bias:.5f}" if bias is not None else "N/A"
        print(f"  {ticker}: corr={corr_s}, bias={bias_s}")

    output = {
        "tickers": MACRO_TICKERS,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "current": {
            "corr": current_corrs,
            "bias": current_biases,
        },
    }

    # Compute rolling frames (skip if --current)
    if not current_only:
        print("Computing rolling frames...")
        # Build per-ticker rolling correlations
        rolling_by_ticker = {}
        for ticker in MACRO_TICKERS:
            candles = macro_data.get(ticker)
            if not candles:
                continue
            macro_rets = log_returns(candles)
            rolling = compute_rolling_correlation(btc_rets, macro_rets, window=168)
            if rolling:
                rolling_by_ticker[ticker] = {r["t"]: r["corr"] for r in rolling}
                print(f"  {ticker}: {len(rolling)} rolling frames")

        # Merge into unified frames (every 4 hours, like replay.json)
        all_ts = set()
        for ts_map in rolling_by_ticker.values():
            all_ts.update(ts_map.keys())
        sorted_ts = sorted(all_ts)

        frames = []
        for i, ts in enumerate(sorted_ts):
            if i % 4 != 0:
                continue

            corrs = []
            biases = []
            for ticker in MACRO_TICKERS:
                ts_map = rolling_by_ticker.get(ticker)
                corrs.append(round(ts_map[ts], 4) if ts_map and ts in ts_map and ts_map[ts] is not None else None)
                # Bias: look back 24 candles in that ticker's series
                candles = macro_data.get(ticker)
                if candles:
                    idx_map = {c["t"]: j for j, c in enumerate(candles)}
                    if ts in idx_map and idx_map[ts] >= 24:
                        j = idx_map[ts]
                        prev = candles[j - 24]["close"]
                        curr = candles[j]["close"]
                        if prev and prev > 0:
                            biases.append(round((curr - prev) / prev, 5))
                        else:
                            biases.append(None)
                    else:
                        biases.append(None)
                else:
                    biases.append(None)

            iso_ts = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            frames.append({"t": iso_ts, "corr": corrs, "bias": biases})

        output["frames"] = frames
        print(f"  {len(frames)} total frames")
    else:
        output["frames"] = []

    # Write output
    DATA_DIR.mkdir(exist_ok=True)
    out_path = DATA_DIR / "macro.json"
    with open(out_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"Wrote {out_path} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
