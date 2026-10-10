// The wording and small calculations of the test console's track record and Polymarket sections.
// Pure functions, so the page's sentences can be tested without rendering it.

export type Record90 = {
  n: number;
  correct: number;
  pct: number | null;
  range90: [number, number] | null;
  brier: number | null;
  days?: number;
};
export type TrackRecord = {
  lastClose: string | null;
  decisions: number;
  pending: number;
  agents: ({ id: string; agent: string } & Record90)[];
  majority: Record90;
  baselines: { alwaysYes: Record90; coinFlip: { n: number; pct: number; brier: number } };
  recent: Decision[];
};
export type Decision = {
  date: string;
  source: string;
  idea: string;
  symbols: string[];
  yesVotes: number;
  votes: number;
  majority?: "yes" | "no" | null;
  basketPct: number | null;
  spyPct: number | null;
  pnl: number | null;
  correct: boolean | null;
};
export type Evidence = {
  title: string;
  url: string;
  probability: number;
  change7d?: number | null;
  symbols?: string[];
};

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** "56% right (45 of 80)": a percentage never appears without its n. */
export function rightText(record: Pick<Record90, "n" | "correct" | "pct">): string {
  if (!record.n || record.pct === null) return "no scored calls yet";
  return `${Math.round(record.pct)}% right (${record.correct} of ${record.n})`;
}

/** The agents, best share of right calls first. */
export function agentsByPct<T extends Pick<Record90, "pct">>(agents: T[]): T[] {
  return [...agents].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

/**
 * One sentence on what the record shows, from the 90% ranges: someone "does better than a coin
 * flip" only when the whole range is above 50%.
 */
export function verdict(track: Pick<TrackRecord, "agents" | "majority">): string {
  const everyone = [...track.agents, { agent: "the panel", ...track.majority }];
  const ranged = everyone.filter((row) => row.n > 0);
  if (!ranged.length) return "No decision has been scored yet.";
  if (ranged.some((row) => !row.range90)) {
    return "Too few weeks so far to say whether anyone does better than a coin flip.";
  }
  const better = ranged.filter((row) => row.range90![0] > 50).map((row) => row.agent);
  const worse = ranged.filter((row) => row.range90![1] < 50).map((row) => row.agent);
  if (!better.length && !worse.length) {
    return "So far, no agent does better than a coin flip: every 90% range includes 50%.";
  }
  if (!better.length) {
    return `So far, no agent does better than a coin flip, and ${list(worse)} ${worse.length > 1 ? "do" : "does"} worse.`;
  }
  const rest = ranged.length - better.length;
  return (
    `So far, ${list(better)} ${better.length > 1 ? "do" : "does"} better than a coin flip` +
    (rest ? "; the others cannot be told apart from one." : ".")
  );
}

/** "8 weeks, 80 decisions." */
export function scopeText(track: Pick<TrackRecord, "decisions" | "baselines">): string {
  const weeks = track.baselines.alwaysYes.days ?? 0;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return `${plural(weeks, "week")}, ${plural(track.decisions, "decision")}.`;
}

/** What the panel said about a basket: "Invest (4 of 5)", "Skip (0 of 5)". */
export function panelSaid(row: Pick<Decision, "yesVotes" | "votes" | "majority">): {
  label: string;
  invest: boolean | null;
} {
  const needed = 3;
  const invest =
    row.majority === "yes" || (row.majority === undefined && row.yesVotes >= needed)
      ? true
      : row.majority === "no" || (row.majority === undefined && row.votes - row.yesVotes >= needed)
        ? false
        : null;
  const count = `(${row.yesVotes} of ${row.votes})`;
  return {
    label: `${invest === null ? "No majority" : invest ? "Invest" : "Skip"} ${count}`,
    invest,
  };
}

const signed = (value: number, digits: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;

/** The basket's week against the S&P 500, in points; null while the week has not passed. */
export function versusMarket(
  row: Pick<Decision, "basketPct" | "spyPct">,
): { points: number; text: string; detail: string } | null {
  if (row.basketPct === null || row.spyPct === null) return null;
  const points = Math.round((row.basketPct - row.spyPct) * 100) / 100;
  return {
    points,
    text: `${signed(points, 2)} pts`,
    detail: `Basket ${signed(row.basketPct, 2)}%, S&P 500 ${signed(row.spyPct, 2)}%`,
  };
}

/** The paper result of $10,000, shown only where the panel said to invest: "made +$302". */
export function paperResult(row: Decision): string | null {
  if (panelSaid(row).invest !== true || row.pnl === null) return null;
  const dollars = Math.round(Math.abs(row.pnl)).toLocaleString("en-US");
  return row.pnl >= 0 ? `made +$${dollars}` : `lost −$${dollars}`;
}

export function resultOf(row: Decision): { text: string; tone: "up" | "down" | "muted" } {
  if (row.basketPct === null) return { text: "Pending", tone: "muted" };
  if (row.correct === null) return { text: "No call", tone: "muted" };
  return row.correct ? { text: "✓ Right", tone: "up" } : { text: "✗ Wrong", tone: "down" };
}

/** Yes and No in whole percent; No is always 100 − Yes. */
export function yesNo(probability: number): { yes: number; no: number } {
  const yes = Math.min(100, Math.max(0, Math.round(probability * 100)));
  return { yes, no: 100 - yes };
}

/** "▲ 2 pts this week", "▼ 1.5 pts this week", "flat this week" or "no 7-day data". */
export function weekMove(change: number | null | undefined): {
  text: string;
  direction: "up" | "down" | "flat" | "none";
} {
  if (change === null || change === undefined || !Number.isFinite(change)) {
    return { text: "no 7-day data", direction: "none" };
  }
  const points = Math.round(Math.abs(change) * 1000) / 10;
  if (points === 0) return { text: "flat this week", direction: "flat" };
  const unit = points === 1 ? "pt" : "pts";
  return change > 0
    ? { text: `▲ ${points} ${unit} this week`, direction: "up" }
    : { text: `▼ ${points} ${unit} this week`, direction: "down" };
}

/** The linked market that moved most this week: what a stock's new weight is driven by. */
export function driverOf(symbol: string, evidence: Evidence[]): Evidence | null {
  const linked = evidence.filter((item) => item.symbols?.includes(symbol));
  if (!linked.length) return null;
  return linked.reduce((best, item) =>
    Math.abs(item.change7d ?? 0) > Math.abs(best.change7d ?? 0) ? item : best,
  );
}
