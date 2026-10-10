// All SQL of the panel's track record: the inputs known on a day (returns from stock_closes),
// saving a decision, scoring it one week later, and reading the record back.
import { db } from "../db/client";
import type { PanelContext, PastCalls, Returns } from "../votes/votes";
import { BENCHMARK } from "./closes";

export type DecisionSource = "replay" | "live";

export type PriceInputs = PanelContext & { returns: Record<string, Returns> };

/**
 * 5- and 20-trading-day returns of the symbols (and SPY) as of the last close on or before
 * `onOrBefore` (YYYY-MM-DD). Nothing after that day is read.
 */
export async function priceInputs(symbols: string[], onOrBefore: string): Promise<PriceInputs> {
  const rows = await db()<
    { symbol: string; as_of: string; c0: number | null; c5: number | null; c20: number | null }[]
  >`
    with days as (
      select day, row_number() over (order by day desc) - 1 as back
      from (
        select distinct day from stock_closes
        where symbol = ${BENCHMARK} and day <= ${onOrBefore}::date
        order by day desc limit 21
      ) recent
    )
    select c.symbol,
           (select day::text from days where back = 0) as as_of,
           max(c.close) filter (where d.back = 0) as c0,
           max(c.close) filter (where d.back = 5) as c5,
           max(c.close) filter (where d.back = 20) as c20
    from stock_closes c join days d on d.day = c.day
    where c.symbol = any(${[BENCHMARK, ...symbols]}) and d.back in (0, 5, 20)
    group by c.symbol`;
  const change = (now: number | null, then: number | null) =>
    now !== null && then !== null && then > 0 ? now / then - 1 : null;
  const returns: Record<string, Returns> = {};
  for (const row of rows) {
    returns[row.symbol] = { r5: change(row.c0, row.c5), r20: change(row.c0, row.c20) };
  }
  const { [BENCHMARK]: spy, ...stocks } = returns;
  return { asOf: rows[0]?.as_of ?? null, spy: spy ?? null, returns: stocks };
}

export type DecisionVote = {
  /** Voter id: growth, value, macro, skeptic, fit. */
  agent: string;
  vote: "yes" | "no";
  probability: number;
  reason: string;
  model?: string | null;
};

export type NewDecision = {
  /** The day of the last close the panel knew. */
  day: string;
  source: DecisionSource;
  idea: string;
  symbols: string[];
  inputs: unknown;
  majority: "yes" | "no" | null;
  votes: DecisionVote[];
};

/**
 * Saves one decision with its votes. The same (source, day, idea, symbols) is kept once; with
 * `replace` (the replay, when it is run again) the earlier row and its votes are written anew.
 */
export async function saveDecision(
  decision: NewDecision,
  options: { replace?: boolean } = {},
): Promise<boolean> {
  const sql = db();
  return sql.begin(async (tx) => {
    if (options.replace) {
      await tx`
        delete from panel_decisions
        where source = ${decision.source} and day = ${decision.day}::date
          and idea = ${decision.idea} and symbols = ${decision.symbols}`;
    }
    const inserted = await tx<{ id: string }[]>`
      insert into panel_decisions (day, source, idea, symbols, inputs, majority)
      values (${decision.day}, ${decision.source}, ${decision.idea}, ${decision.symbols},
              ${tx.json(decision.inputs as never)}, ${decision.majority})
      on conflict (source, day, idea, symbols) do nothing
      returning id`;
    if (!inserted.length) return false;
    if (decision.votes.length) {
      const rows = decision.votes.map((vote) => ({
        decision_id: inserted[0].id,
        agent: vote.agent,
        vote: vote.vote,
        probability: vote.probability,
        reason: vote.reason,
        model: vote.model ?? null,
      }));
      await tx`insert into panel_votes ${tx(rows, "decision_id", "agent", "vote", "probability", "reason", "model")}`;
    }
    return true;
  });
}

/**
 * Scores every decision that is a week old and whose closes are loaded: the equal-weighted
 * basket against SPY from the decision day's close to the last close on or before day + 7.
 * yes is correct if the basket beat SPY, no if it did not. Returns how many were scored.
 */
export async function scoreDueDecisions(): Promise<number> {
  const sql = db();
  const scored = await sql<{ id: string }[]>`
    with last_close as (select max(day) as day from stock_closes where symbol = ${BENCHMARK}),
    due as (
      select d.id, d.symbols, d.majority,
             (select max(day) from stock_closes
              where symbol = ${BENCHMARK} and day <= d.day) as entry_day,
             (select max(day) from stock_closes
              where symbol = ${BENCHMARK} and day <= d.day + 7) as exit_day
      from panel_decisions d, last_close
      where d.scored_at is null and last_close.day >= d.day + 7
    ),
    outcome as (
      select due.id, due.majority, due.exit_day,
             (select avg(x.close / e.close - 1)
              from unnest(due.symbols) as s(symbol)
              join stock_closes e on e.symbol = s.symbol and e.day = due.entry_day
              join stock_closes x on x.symbol = s.symbol and x.day = due.exit_day) as basket,
             (select count(*)
              from unnest(due.symbols) as s(symbol)
              join stock_closes e on e.symbol = s.symbol and e.day = due.entry_day
              join stock_closes x on x.symbol = s.symbol and x.day = due.exit_day) as priced,
             (select x.close / e.close - 1
              from stock_closes e join stock_closes x on x.symbol = e.symbol
              where e.symbol = ${BENCHMARK} and e.day = due.entry_day
                and x.day = due.exit_day) as spy
      from due
      where due.exit_day > due.entry_day
    )
    update panel_decisions d set
      scored_day = o.exit_day,
      basket_return = o.basket,
      spy_return = o.spy,
      pnl = round((10000 * o.basket)::numeric, 2)::double precision,
      majority_correct = case when o.majority is null then null
                              else (o.majority = 'yes') = (o.basket > o.spy) end,
      scored_at = now()
    from outcome o
    where d.id = o.id and o.spy is not null and o.priced = cardinality(d.symbols)
    returning d.id`;
  await sql`
    update panel_votes v set correct = (v.vote = 'yes') = (d.basket_return > d.spy_return)
    from panel_decisions d
    where v.decision_id = d.id and d.scored_at is not null and v.correct is null`;
  return scored.length;
}

/** Each agent's scored basket calls. `scoredOnOrBefore` limits it to what was known by that day. */
export async function pastCalls(
  options: { scoredOnOrBefore?: string; source?: DecisionSource } = {},
): Promise<Record<string, PastCalls>> {
  const sql = db();
  const rows = await sql<{ agent: string; n: number; correct: number }[]>`
    select v.agent, count(*)::int as n, count(*) filter (where v.correct)::int as correct
    from panel_votes v join panel_decisions d on d.id = v.decision_id
    where v.correct is not null
      ${options.scoredOnOrBefore ? sql`and d.scored_day <= ${options.scoredOnOrBefore}::date` : sql``}
      ${options.source ? sql`and d.source = ${options.source}` : sql``}
    group by v.agent`;
  return Object.fromEntries(rows.map((row) => [row.agent, { n: row.n, correct: row.correct }]));
}

export type ScoredVoteRow = {
  decisionId: string;
  day: string;
  agent: string;
  probability: number;
  correct: boolean;
  beat: boolean;
};
export type ScoredDecisionRow = {
  decisionId: string;
  day: string;
  majority: "yes" | "no" | null;
  majorityCorrect: boolean | null;
  beat: boolean;
};

/** Every scored vote and decision, for the statistics. */
export async function scoredRows(): Promise<{
  votes: ScoredVoteRow[];
  decisions: ScoredDecisionRow[];
  pending: number;
  lastClose: string | null;
}> {
  const sql = db();
  const votes = await sql<ScoredVoteRow[]>`
    select d.id::text as "decisionId", d.day::text as day, v.agent, v.probability,
           v.correct, (d.basket_return > d.spy_return) as beat
    from panel_votes v join panel_decisions d on d.id = v.decision_id
    where v.correct is not null
    order by d.day, d.id`;
  const decisions = await sql<ScoredDecisionRow[]>`
    select id::text as "decisionId", day::text as day, majority,
           majority_correct as "majorityCorrect", (basket_return > spy_return) as beat
    from panel_decisions where scored_at is not null
    order by day, id`;
  const [{ pending }] = await sql<{ pending: number }[]>`
    select count(*)::int as pending from panel_decisions where scored_at is null`;
  const [{ last_close }] = await sql<{ last_close: string | null }[]>`
    select max(day)::text as last_close from stock_closes where symbol = ${BENCHMARK}`;
  return { votes: [...votes], decisions: [...decisions], pending, lastClose: last_close };
}

export type RecentDecision = {
  date: string;
  source: DecisionSource;
  idea: string;
  symbols: string[];
  /** Agents that expected the basket to beat SPY, out of `votes`. */
  yesVotes: number;
  votes: number;
  majority: "yes" | "no" | null;
  /** Null until the decision is a week old and scored. */
  basketPct: number | null;
  spyPct: number | null;
  pnl: number | null;
  /** Was the majority right? Null while pending or when there was no majority. */
  correct: boolean | null;
};

export async function recentDecisions(limit = 20): Promise<RecentDecision[]> {
  const rows = await db()<RecentDecision[]>`
    select d.day::text as date, d.source, d.idea, d.symbols,
           (select count(*) filter (where v.vote = 'yes')::int
            from panel_votes v where v.decision_id = d.id) as "yesVotes",
           (select count(*)::int from panel_votes v where v.decision_id = d.id) as votes,
           d.majority,
           round((d.basket_return * 100)::numeric, 2)::double precision as "basketPct",
           round((d.spy_return * 100)::numeric, 2)::double precision as "spyPct",
           d.pnl,
           d.majority_correct as correct
    from panel_decisions d
    order by d.day desc, d.id desc
    limit ${limit}`;
  return [...rows];
}
