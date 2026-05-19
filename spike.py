#!/usr/bin/env python3
"""
el5/spike.py — radial-correlation viability spike.

Pulls 12 months of hourly OHLC for BTC + 12 alts from Coinbase Exchange's
public API, computes rolling 30-day Pearson correlations of each alt's
log-returns against BTC's, and reports whether the resulting peer-radius
distribution has enough spread to make HackTrader's radial visualization
informative on this asset class.

Run on a Mac with internet access. No API key required.

Outputs:
  data/{SYMBOL}_1h.csv          raw OHLC history per symbol
  data/correlations_30d.csv     wide table of rolling Pearson corr vs BTC
  results/summary.md            human-readable verdict + stats
  results/spread_histogram.png  distribution of all pairwise correlations
  results/sample_radial.png     three radial layouts at recent timestamps

Re-run with `--skip-fetch` to recompute analysis only.
"""
import argparse
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import matplotlib.pyplot as plt

COINBASE = "https://api.exchange.coinbase.com/products"
FOCUS = "BTC"
ALTS = [
    "ETH", "SOL", "BCH", "XRP", "ADA", "AVAX",
    "DOGE", "DOT", "LINK", "ATOM", "NEAR", "LTC",
]
ALL = [FOCUS] + ALTS

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"


def fetch_klines(symbol: str, days: int = 365) -> pd.DataFrame:
    product = f"{symbol}-USD"
    granularity = 3600
    end_dt = datetime.now(tz=timezone.utc).replace(microsecond=0)
    start_dt = end_dt - timedelta(days=days)
    chunk_window = timedelta(seconds=300 * granularity)

    rows = []
    cursor = start_dt
    while cursor < end_dt:
        chunk_end = min(cursor + chunk_window, end_dt)
        params = {
            "granularity": granularity,
            "start": cursor.isoformat(),
            "end": chunk_end.isoformat(),
        }
        r = requests.get(f"{COINBASE}/{product}/candles", params=params, timeout=15)
        r.raise_for_status()
        chunk = r.json()
        if isinstance(chunk, dict) and "message" in chunk:
            raise RuntimeError(f"Coinbase error for {product}: {chunk['message']}")
        if chunk:
            rows.extend(chunk)
        cursor = chunk_end
        time.sleep(0.12)

    if not rows:
        raise RuntimeError(f"No candles returned for {product}")
    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    df["ts"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df["close"] = df["close"].astype(float)
    df["volume"] = df["volume"].astype(float)
    df = df.drop_duplicates(subset="ts").sort_values("ts").reset_index(drop=True)
    return df[["ts", "close", "volume"]]


def fetch_all():
    DATA.mkdir(parents=True, exist_ok=True)
    for sym in ALL:
        out = DATA / f"{sym}_1h.csv"
        if out.exists():
            print(f"[skip] {sym} — {out.name} already exists (delete to refetch)")
            continue
        print(f"[fetch] {sym}-USD — hourly candles, 365 days")
        df = fetch_klines(sym)
        df.to_csv(out, index=False)
        print(f"  {len(df)} bars | {df.ts.min()} -> {df.ts.max()}")


def compute_correlations() -> pd.DataFrame:
    closes = {}
    for sym in ALL:
        df = pd.read_csv(DATA / f"{sym}_1h.csv", parse_dates=["ts"])
        closes[sym] = df.set_index("ts")["close"]
    px = pd.DataFrame(closes).sort_index()
    rets = np.log(px).diff().dropna(how="all")
    window = 24 * 30
    corrs = pd.DataFrame(index=rets.index)
    btc = rets[FOCUS]
    for alt in ALTS:
        corrs[alt] = rets[alt].rolling(window).corr(btc)
    return corrs.dropna(how="all")


def write_summary(corrs: pd.DataFrame):
    RESULTS.mkdir(parents=True, exist_ok=True)
    flat = corrs.stack()
    spread = corrs.max(axis=1) - corrs.min(axis=1)
    median_corr = flat.median()
    median_spread = spread.median()

    if median_spread >= 0.30:
        verdict = "STRONG SPREAD - radial viz reads as a distribution. Build."
    elif median_spread >= 0.15:
        verdict = "MARGINAL - viz reads but most peers cluster."
    else:
        verdict = "PANCAKE - radial encoding adds no information for this asset class."

    lines = [
        "# el5 spike - radial viability verdict",
        "",
        f"- Window: `{corrs.index.min()}` to `{corrs.index.max()}`",
        f"- Focus: `BTC`",
        f"- Peer basket ({len(ALTS)} alts): {', '.join(ALTS)}",
        f"- Source: Coinbase Exchange | hourly | rolling 30-day Pearson (720h)",
        "",
        "## Pairwise correlation vs BTC",
        "",
        f"- Median: **{median_corr:.3f}**",
        f"- p10: `{flat.quantile(0.10):.3f}`",
        f"- p90: `{flat.quantile(0.90):.3f}`",
        "",
        "## Basket spread (max - min per timestamp)",
        "",
        f"- Median: **{median_spread:.3f}**",
        f"- p10: `{spread.quantile(0.10):.3f}`",
        f"- p90: `{spread.quantile(0.90):.3f}`",
        "",
        "## Verdict",
        "",
        f"**{verdict}**",
        "",
        "## Per-alt stats",
        "",
        "| Alt | Median | p10 | p90 | Stdev |",
        "|---|---|---|---|---|",
    ]
    for alt in ALTS:
        s = corrs[alt].dropna()
        lines.append(
            f"| {alt} | {s.median():.3f} | {s.quantile(0.10):.3f} | "
            f"{s.quantile(0.90):.3f} | {s.std():.3f} |"
        )
    out = RESULTS / "summary.md"
    out.write_text("\n".join(lines) + "\n")
    print()
    print(out.read_text())


def plot_histogram(corrs: pd.DataFrame):
    flat = corrs.stack()
    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=110)
    ax.hist(flat, bins=60, color="#5eead4", edgecolor="#06111d", linewidth=0.6)
    med = flat.median()
    ax.axvline(med, color="#f87171", linestyle="--", label=f"median {med:.2f}")
    ax.set_xlabel("Rolling 30-day Pearson correlation vs BTC")
    ax.set_ylabel("count")
    ax.set_title("Distribution of peer-vs-BTC correlations over 12 months")
    ax.legend()
    fig.tight_layout()
    fig.savefig(RESULTS / "spread_histogram.png")
    plt.close(fig)


def plot_radial_samples(corrs: pd.DataFrame):
    n = len(corrs)
    idxs = [n - 1, n // 2, n // 4]
    timestamps = [corrs.index[i] for i in idxs]
    fig, axes = plt.subplots(1, 3, figsize=(15, 5.2), dpi=110, subplot_kw=dict(aspect="equal"))
    for ax, ts in zip(axes, timestamps):
        row = corrs.loc[ts]
        angles = np.linspace(0, 2 * np.pi, len(ALTS), endpoint=False) + np.pi / 2
        radii = 1 - np.abs(row.values)
        xs = radii * np.cos(angles)
        ys = radii * np.sin(angles)
        for ring in (0.3, 0.5, 0.7):
            ax.add_patch(plt.Circle((0, 0), ring, fill=False, color="#9cb0ca", alpha=0.25, ls=":"))
        for x, y in zip(xs, ys):
            ax.plot([0, x], [0, y], color="#9cb0ca", lw=0.5, alpha=0.45)
        ax.scatter([0], [0], s=520, c="#5eead4", zorder=3, edgecolors="#06111d", linewidths=1)
        ax.text(0, 0, "BTC", ha="center", va="center", fontsize=10, fontweight="bold", color="#06111d", zorder=4)
        for x, y, name, r in zip(xs, ys, ALTS, row.values):
            ax.scatter([x], [y], s=160, c="#60a5fa", zorder=2, edgecolors="#06111d", linewidths=0.8)
            ax.text(x * 1.16, y * 1.16, name, ha="center", va="center", fontsize=8, color="#06111d")
        ax.set_xlim(-1.2, 1.2)
        ax.set_ylim(-1.2, 1.2)
        ax.set_title(ts.strftime("%Y-%m-%d %H:%M UTC"), fontsize=10)
        ax.axis("off")
    fig.suptitle("Sample radial layouts - distance from BTC = 1 - |Pearson|", y=1.02, fontsize=11)
    fig.tight_layout()
    fig.savefig(RESULTS / "sample_radial.png", bbox_inches="tight")
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-fetch", action="store_true")
    args = ap.parse_args()
    if not args.skip_fetch:
        fetch_all()
    corrs = compute_correlations()
    corrs.to_csv(DATA / "correlations_30d.csv")
    write_summary(corrs)
    plot_histogram(corrs)
    plot_radial_samples(corrs)
    print("\nDone.")


if __name__ == "__main__":
    main()
