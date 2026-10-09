"""Pure weighting math: no network, no I/O.

A basket's live weight for holding i is

    multiplier_i = clip(1 + k * sum_s beta_is * (P_s - P_ref_s), 0, MAX_MULTIPLIER)
    weight_i     = base_i * multiplier_i / sum_j base_j * multiplier_j

where P_s is the signal's current (or what-if) probability, P_ref_s its
probability at the start of the look-back window, beta_is how holding i
responds to that event (signed), and k the user's sensitivity.
"""

from __future__ import annotations

from typing import Any

WINDOWS = ("1d", "1w", "1m")
MAX_MULTIPLIER = 3.0


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def signal_move(signal: dict[str, Any], window: str, overrides: dict[str, float]) -> dict[str, float] | None:
    """Return the probability now, at the window start, and the shift between them."""
    if signal.get("price") is None:
        return None
    live = float(signal["price"])
    change = (signal.get("changes") or {}).get(window) or 0.0
    ref = clamp(live - change, 0.0, 1.0)
    now = clamp(float(overrides.get(signal["id"], live)), 0.0, 1.0)
    return {"now": now, "ref": ref, "live": live, "delta": now - ref}


def scope_holdings(sectors: list[dict[str, Any]], scope: list[str]) -> list[dict[str, Any]]:
    """Holdings for the chosen sectors; each sector gets an equal share of the basket."""
    chosen = [s for s in sectors if s["id"] in scope]
    if not chosen:
        return []
    share = 100.0 / len(chosen)
    seen: dict[str, dict[str, Any]] = {}
    for sector in chosen:
        total = sum(h["base"] for h in sector["holdings"])
        for h in sector["holdings"]:
            base = share * h["base"] / total
            if h["symbol"] in seen:
                seen[h["symbol"]]["base"] += base
            else:
                seen[h["symbol"]] = {**h, "base": base, "sector": sector["id"]}
    return list(seen.values())


def reweight(
    holdings: list[dict[str, Any]],
    signals: list[dict[str, Any]],
    *,
    window: str = "1w",
    sensitivity: float = 2.0,
    overrides: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    overrides = overrides or {}
    moves = {s["id"]: signal_move(s, window, overrides) for s in signals}

    rows = []
    for h in holdings:
        contributions = []
        for s in signals:
            beta = s["betas"].get(h["symbol"])
            move = moves[s["id"]]
            if not beta or move is None:
                continue
            contributions.append({
                "signal": s["id"],
                "beta": beta,
                "delta": move["delta"],
                "effect": sensitivity * beta * move["delta"],
            })
        contributions.sort(key=lambda c: abs(c["effect"]), reverse=True)
        multiplier = clamp(1.0 + sum(c["effect"] for c in contributions), 0.0, MAX_MULTIPLIER)
        rows.append({**h, "multiplier": multiplier, "contributions": contributions})

    raw_total = sum(r["base"] * r["multiplier"] for r in rows)
    base_total = sum(r["base"] for r in rows) or 1.0
    for r in rows:
        r["base_pct"] = 100.0 * r["base"] / base_total
        # If every holding is zeroed out, fall back to the base weights.
        r["weight_pct"] = 100.0 * r["base"] * r["multiplier"] / raw_total if raw_total > 0 else r["base_pct"]
        r["change_pct"] = r["weight_pct"] - r["base_pct"]
        del r["base"]
    return rows


def relevant_signals(holdings: list[dict[str, Any]], signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    symbols = {h["symbol"] for h in holdings}
    return [s for s in signals if symbols & s["betas"].keys()]


def expansion_suggestions(
    sectors: list[dict[str, Any]],
    scope: list[str],
    signals: list[dict[str, Any]],
    *,
    window: str = "1w",
    sensitivity: float = 2.0,
    limit: int = 3,
    min_score: float = 0.01,
) -> list[dict[str, Any]]:
    """Rank sectors outside the scope by how hard current Polymarket moves would tilt them.

    A sector's score is the base-weighted average |multiplier - 1| its holdings
    would see, so 0.05 means the feed is tilting that sector about 5%.
    """
    moves = {s["id"]: signal_move(s, window, {}) for s in signals}
    out = []
    for sector in sectors:
        if sector["id"] in scope:
            continue
        total = sum(h["base"] for h in sector["holdings"])
        by_signal: dict[str, float] = {}
        for s in signals:
            move = moves[s["id"]]
            if move is None:
                continue
            impact = sum(
                h["base"] / total * abs(s["betas"].get(h["symbol"], 0.0))
                for h in sector["holdings"]
            ) * abs(move["delta"]) * sensitivity
            if impact > 0:
                by_signal[s["id"]] = impact
        score = sum(by_signal.values())
        if score < min_score:
            continue
        driver = max(by_signal, key=by_signal.get)
        label = next(s["label"] for s in signals if s["id"] == driver)
        out.append({
            "sector": sector["id"],
            "name": sector["name"],
            "score": score,
            "driver": driver,
            "driver_label": label,
            "driver_delta": moves[driver]["delta"],
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    return out[:limit]


def trade_ticket(rows: list[dict[str, Any]], amount: float, prices: dict[str, float]) -> list[dict[str, Any]]:
    """Split a dollar amount across weights in whole cents that add up exactly."""
    cents = round(amount * 100)
    exact = [cents * r["weight_pct"] / 100.0 for r in rows]
    alloc = [int(x) for x in exact]
    # Largest remainder: hand leftover cents to the biggest fractional parts.
    order = sorted(range(len(rows)), key=lambda i: exact[i] - alloc[i], reverse=True)
    for i in order[: cents - sum(alloc)]:
        alloc[i] += 1

    lines = []
    for r, c in zip(rows, alloc):
        if c == 0:
            continue
        price = prices.get(r["symbol"])
        dollars = c / 100.0
        lines.append({
            "symbol": r["symbol"],
            "name": r["name"],
            "weight_pct": r["weight_pct"],
            "dollars": dollars,
            "price": price,
            "units": dollars / price if price else None,
        })
    return lines


def round_weights(weights_pct: list[float], decimals: int = 2) -> list[float]:
    """Round percentages so they still total exactly 100 (largest remainder)."""
    scale = 10 ** decimals
    exact = [w * scale for w in weights_pct]
    floors = [int(x) for x in exact]
    order = sorted(range(len(exact)), key=lambda i: exact[i] - floors[i], reverse=True)
    for i in order[: 100 * scale - sum(floors)]:
        floors[i] += 1
    return [f / scale for f in floors]


def explain(rows: list[dict[str, Any]], signals: list[dict[str, Any]], window: str) -> str:
    """Plain-English summary of which odds moves drove the biggest weight changes."""
    span = {"1d": "day", "1w": "week", "1m": "month"}[window]
    labels = {s["id"]: s for s in signals}
    movers = sorted(rows, key=lambda r: -abs(r["change_pct"]))[:3]
    parts = []
    for r in movers:
        if abs(r["change_pct"]) < 0.05 or not r["contributions"]:
            continue
        move = f"{r['symbol']} {r['base_pct']:.1f}% → {r['weight_pct']:.1f}%"
        c = r["contributions"][0]
        if (c["effect"] > 0) != (r["change_pct"] > 0):
            # Its own signal pushed the other way; it moved because other holdings moved more.
            parts.append(f"{move} (diluted as other holdings grew)" if r["change_pct"] < 0 else f"{move} (as other holdings shrank)")
            continue
        top = labels[c["signal"]]
        pts = abs(c["delta"] * 100)
        parts.append(
            f"{move} (“{top['question']}” {'up' if c['delta'] > 0 else 'down'} "
            f"{pts:.0f} {'pt' if round(pts) == 1 else 'pts'} to {top['price'] * 100:.0f}%)"
        )
    detail = ": " + "; ".join(parts) if parts else ", with only small changes to each holding"
    return (
        f"Tilted by Polymarket odds moves over the past {span}{detail}. "
        "Event probabilities indicate risk, not expected returns."
    )
