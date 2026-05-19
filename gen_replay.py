#!/usr/bin/env python3
"""
gen_replay.py — Generate data/replay.json from spike CSVs.

Reads correlations_30d.csv + per-token 1h CSVs, downsamples to every 4 hours,
and outputs a compact JSON file for the dashboard replay feature.

Output format:
{
  "peers": ["ETH", "SOL", ...],
  "frames": [
    {
      "t": "2025-06-18T08:00:00Z",
      "btc": 65432.10,
      "corr": [0.77, 0.79, ...],       // per-peer correlation (same order as peers)
      "bias": [0.012, -0.003, ...],     // per-peer 24h change (null if unavailable)
      "vol":  [0.0012, 0.0015, ...]     // per-peer hourly stddev of log returns
    },
    ...
  ]
}
"""

import csv
import json
import math
import os
import sys
from datetime import datetime, timezone

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
PEERS = ["ETH", "SOL", "BCH", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "ATOM", "NEAR", "LTC"]
DOWNSAMPLE = 4  # every 4 hours


def read_csv(path):
    """Read a CSV into a list of dicts."""
    with open(path, "r") as f:
        return list(csv.DictReader(f))


def parse_ts(ts_str):
    """Normalize timestamp string to ISO format key."""
    # Handle '+00:00' suffix
    ts_str = ts_str.strip()
    if ts_str.endswith("+00:00"):
        ts_str = ts_str[:-6]
    return ts_str.replace(" ", "T") + "Z"


def compute_vol(closes, idx, window=168):
    """Compute hourly log-return stddev over a trailing window."""
    start = max(0, idx - window)
    rets = []
    for i in range(start + 1, idx + 1):
        prev, curr = closes[i - 1], closes[i]
        if prev > 0 and curr > 0:
            rets.append(math.log(curr / prev))
    if len(rets) < 10:
        return None
    mean = sum(rets) / len(rets)
    variance = sum((r - mean) ** 2 for r in rets) / len(rets)
    return round(math.sqrt(variance), 6)


def compute_bias(closes, idx, lookback=24):
    """Compute 24h percentage change."""
    if idx < lookback:
        return None
    prev, curr = closes[idx - lookback], closes[idx]
    if prev <= 0:
        return None
    return round((curr - prev) / prev, 5)


def main():
    print("Loading correlations...")
    corr_rows = read_csv(os.path.join(DATA_DIR, "correlations_30d.csv"))

    # Build timestamp-indexed correlation lookup
    corr_by_ts = {}
    for row in corr_rows:
        ts = parse_ts(row["ts"])
        corr_by_ts[ts] = {peer: float(row[peer]) for peer in PEERS}

    print(f"  {len(corr_rows)} correlation rows")

    # Load BTC prices
    print("Loading BTC prices...")
    btc_rows = read_csv(os.path.join(DATA_DIR, "BTC_1h.csv"))
    btc_by_ts = {}
    btc_ts_list = []
    btc_closes = []
    for row in btc_rows:
        ts = parse_ts(row["ts"])
        close = float(row["close"])
        btc_by_ts[ts] = close
        btc_ts_list.append(ts)
        btc_closes.append(close)
    print(f"  {len(btc_rows)} BTC rows")

    # Load peer prices
    print("Loading peer prices...")
    peer_data = {}  # { symbol: { ts_list, closes } }
    for sym in PEERS:
        path = os.path.join(DATA_DIR, f"{sym}_1h.csv")
        if not os.path.exists(path):
            print(f"  WARNING: {path} not found, skipping {sym}")
            continue
        rows = read_csv(path)
        ts_list = []
        closes = []
        by_ts = {}
        for row in rows:
            ts = parse_ts(row["ts"])
            close = float(row["close"])
            ts_list.append(ts)
            closes.append(close)
            by_ts[ts] = len(ts_list) - 1  # index
        peer_data[sym] = {"ts_list": ts_list, "closes": closes, "by_ts": by_ts}
        print(f"  {sym}: {len(rows)} rows")

    # Build frames from correlation timestamps (downsampled)
    print(f"Building frames (downsample={DOWNSAMPLE})...")
    corr_timestamps = sorted(corr_by_ts.keys())
    frames = []

    for i, ts in enumerate(corr_timestamps):
        if i % DOWNSAMPLE != 0:
            continue

        btc_price = btc_by_ts.get(ts)
        if btc_price is None:
            continue

        corrs = corr_by_ts[ts]

        peer_biases = []
        peer_vols = []
        for sym in PEERS:
            if sym not in peer_data or ts not in peer_data[sym]["by_ts"]:
                peer_biases.append(None)
                peer_vols.append(None)
                continue

            idx = peer_data[sym]["by_ts"][ts]
            closes = peer_data[sym]["closes"]
            peer_biases.append(compute_bias(closes, idx))
            peer_vols.append(compute_vol(closes, idx))

        frame = {
            "t": ts,
            "btc": round(btc_price, 2),
            "corr": [round(corrs[p], 4) for p in PEERS],
            "bias": peer_biases,
            "vol": peer_vols,
        }
        frames.append(frame)

    print(f"  {len(frames)} frames")

    # Write output
    output = {"peers": PEERS, "frames": frames}
    out_path = os.path.join(DATA_DIR, "replay.json")
    with open(out_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Wrote {out_path} ({size_kb:.0f} KB, {len(frames)} frames)")


if __name__ == "__main__":
    main()
