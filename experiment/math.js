/** Allocation is independent of every event probability and scenario. */
export function allocate(stocks, method = "equal", caps = {}) {
  if (!stocks.length) return [];
  if (new Set(stocks.map(s => s.symbol)).size !== stocks.length) throw new Error("Duplicate stocks.");
  if (!["equal", "float-cap"].includes(method)) throw new Error("Unknown weighting method.");
  const values = stocks.map(s => method === "equal" ? 1 : caps[s.symbol]?.floatAdjustedMarketCap);
  if (values.some(v => !Number.isFinite(v) || v <= 0)) throw new Error("Every selected stock needs valid float-adjusted market-cap data.");
  // Scale before summing to avoid overflow with large values.
  const largest = Math.max(...values);
  const total = values.reduce((sum, v) => sum + v / largest, 0);
  const exact = values.map(v => v / largest / total * 10000);
  const cents = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => (exact[b] - cents[b]) - (exact[a] - cents[a]));
  for (const i of order.slice(0, 10000 - cents.reduce((a, b) => a + b, 0))) cents[i]++;
  return stocks.map((s, i) => ({ ...s, weightPct: cents[i] / 100 }));
}

export function validateCaps(input, now = Date.now()) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error("Upload a JSON array of market-cap records.");
  const out = {};
  for (const row of input) {
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.symbol ?? "") || out[row.symbol]) throw new Error("Every record needs a unique ticker.");
    if (!Number.isFinite(row.floatAdjustedMarketCap) || row.floatAdjustedMarketCap <= 0) throw new Error(`${row.symbol}: float-adjusted market cap must be positive.`);
    const timestamp = Date.parse(row.asOf);
    const url = new URL(row.source);
    if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > 30 * 86400000) throw new Error(`${row.symbol}: use market-cap data from the last 30 days.`);
    if (!["https:", "http:"].includes(url.protocol) || typeof row.currency !== "string" || row.currency !== "USD") throw new Error("Use sourced market-cap values in USD.");
    out[row.symbol] = { ...row };
  }
  const days = Object.values(out).map(row => Date.parse(row.asOf));
  if (Math.max(...days) - Math.min(...days) > 86400000) throw new Error("Use market-cap records from the same observation date.");
  return out;
}

/** US equity close, including daylight saving time, for a Yahoo trading-date label. */
export function closeTimestamp(day) {
  const candidate = Date.parse(`${day}T20:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(candidate));
  return (candidate + (hour === 16 ? 0 : 3600000)) / 1000;
}

export function alignHistory(prices, benchmark, history) {
  const market = new Map(benchmark.map(p => [p.date, p.close]));
  const observations = history.filter(p => Number.isFinite(p.timestamp) && p.price > 0 && p.price < 1).sort((a, b) => a.timestamp - b.timestamp);
  const rows = [];
  let cursor = -1, previous = null;
  for (const price of [...prices].sort((a, b) => a.date.localeCompare(b.date))) {
    const cutoff = closeTimestamp(price.date);
    while (cursor + 1 < observations.length && observations[cursor + 1].timestamp <= cutoff) cursor++;
    const point = observations[cursor];
    const spy = market.get(price.date);
    if (!point || cutoff - point.timestamp > 18 * 3600 || !(price.close > 0) || !(spy > 0)) { previous = null; continue; }
    const current = { date: price.date, p: point.price, stock: price.close, spy };
    // Missing snapshots break the pair. Weekend moves roll into the next trading day.
    if (previous && Date.parse(current.date) - Date.parse(previous.date) <= 4 * 86400000) {
      const y = current.stock / previous.stock - 1;
      const z = current.spy / previous.spy - 1;
      const x = current.p - previous.p;
      if (Math.abs(y) <= 0.2 && Math.abs(z) <= 0.2) rows.push({ date: current.date, x, y, z });
    }
    previous = current;
  }
  return rows;
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const dot = (xs, ys) => xs.reduce((a, x, i) => a + x * ys[i], 0);

/** OLS y ~ 1 + oddsChange + SPYReturn, with a Newey–West (lag 5) slope standard error. */
export function fitAssociation(rows, minObservations = 60) {
  if (rows.length < minObservations) return null;
  const x = rows.map(r => r.x), y = rows.map(r => r.y), z = rows.map(r => r.z);
  if ([...x, ...y, ...z].some(v => !Number.isFinite(v))) return null;
  const mx = mean(x), my = mean(y), mz = mean(z);
  const dx = x.map(v => v - mx), dy = y.map(v => v - my), dz = z.map(v => v - mz);
  const zz = dot(dz, dz);
  if (zz < 1e-12) return null;
  const xz = dot(dx, dz) / zz, yz = dot(dy, dz) / zz;
  const rx = dx.map((v, i) => v - xz * dz[i]), ry = dy.map((v, i) => v - yz * dz[i]);
  const xx = dot(rx, rx), yy = dot(ry, ry);
  // Tiny or almost constant odds changes cannot support an informative slope.
  if (xx / rows.length < 1e-7 || yy < 1e-12) return null;
  const slope = dot(rx, ry) / xx;
  const residuals = ry.map((v, i) => v - slope * rx[i]);
  const scores = residuals.map((v, i) => v * rx[i]);
  let variance = dot(scores, scores);
  const lag = Math.min(5, rows.length - 1);
  for (let k = 1; k <= lag; k++) {
    let covariance = 0;
    for (let i = k; i < scores.length; i++) covariance += scores[i] * scores[i - k];
    variance += 2 * (1 - k / (lag + 1)) * covariance;
  }
  const se = Math.sqrt(Math.max(0, variance) * rows.length / (rows.length - 3)) / xx;
  const t = se > 0 ? slope / se : 0;
  // Two-sided normal approximation, labelled exploratory in the interface.
  const a = Math.abs(t), u = 1 / (1 + 0.2316419 * a);
  const pValue = Math.min(1, 2 * Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI) *
    (0.319381530 * u - 0.356563782 * u ** 2 + 1.781477937 * u ** 3 - 1.821255978 * u ** 4 + 1.330274429 * u ** 5));
  const correlation = dot(rx, ry) / Math.sqrt(xx * yy);
  return { slope, se, pValue, correlation, partialR2: Math.min(1, correlation ** 2), n: rows.length,
    start: rows[0].date, end: rows.at(-1).date, maxDailyMove: Math.max(...x.map(Math.abs)),
    points: rows.map((r, i) => ({ x: rx[i], y: ry[i] })),
  };
}

export function association(prices, benchmark, history) {
  const rows = alignHistory(prices, benchmark, history);
  const fit = fitAssociation(rows);
  if (!fit) return { status: "insufficient", n: rows.length, reason: "Not enough overlapping, varying daily observations for an estimate." };
  const split = Math.floor(rows.length * 0.8);
  const training = fitAssociation(rows.slice(0, split));
  const holdout = fitAssociation(rows.slice(split), 20);
  return { ...fit, status: "exploratory", holdout: holdout && training ? {
    n: holdout.n, start: holdout.start, end: holdout.end,
    slope: holdout.slope, directionStable: Math.sign(training.slope) === Math.sign(holdout.slope),
  } : null };
}

/** FDR correction is across this stock's tested event family, never a causal relevance score. */
export function qualifyAssociations(events) {
  const tests = events.filter(e => e.fit.status !== "insufficient").sort((a, b) => a.fit.pValue - b.fit.pValue);
  let previous = 1;
  for (let i = tests.length - 1; i >= 0; i--) {
    previous = Math.min(previous, tests[i].fit.pValue * tests.length / (i + 1));
    tests[i].fit.qValue = previous;
  }
  for (const event of tests) {
    const fit = event.fit;
    fit.status = fit.n >= 120 && fit.qValue <= 0.1 && Math.abs(fit.slope) > 1.96 * fit.se && fit.holdout?.directionStable
      ? "observed" : "weak";
  }
  return events;
}

export function scenario(fit, from, to) {
  if (!fit || fit.status === "insufficient") return null;
  if (![from, to].every(p => Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error("Probabilities must be between 0 and 1.");
  const delta = to - from;
  const estimate = fit.slope * delta * 100;
  const margin = 1.96 * fit.se * Math.abs(delta) * 100;
  return { estimatePct: estimate, lowPct: estimate - margin, highPct: estimate + margin,
    extrapolated: Math.abs(delta) > fit.maxDailyMove,
  };
}
