const DAY = 86400;
const validOdds = value => Number.isFinite(value) && value >= 0 && value <= 1;

/** Same contract/outcome only. No interpolation or future samples; at most a day's gap. */
export function weeklyOddsChange(event) {
  const end = Date.parse(event.observedAt) / 1000;
  if (event.status !== "available" || !validOdds(event.probability) || !Number.isFinite(end)) return null;
  const target = end - 7 * DAY;
  const reference = (event.history ?? []).filter(p => Number.isFinite(p.timestamp) && p.timestamp <= target && p.timestamp >= target - DAY && validOdds(p.price))
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return reference ? { change: event.probability - reference.price, from: reference.timestamp, to: end } : null;
}

/** Only evidence touching the idea's businesses participates in the suggestion cache key. */
export function suggestionEvidence(events, symbols) {
  return events.filter(e => e.linkedSymbols?.some(s => symbols.includes(s)))
    .map(e => ({ id: e.id, provider: e.provider, marketId: e.marketId, outcome: e.outcome ?? "Yes", endDate: e.endDate,
      title: e.title ?? e.label, subtitle: e.subtitle, status: e.status, stale: Boolean(e.stale), probability: e.probability,
      linkedSymbols: [...e.linkedSymbols].sort() })).sort((a, b) => a.id.localeCompare(b.id));
}
