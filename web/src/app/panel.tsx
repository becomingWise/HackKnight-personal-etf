// The AI panel on the Build page: five agents' votes on each stock, their call on the whole
// basket, and each agent's record so far. Data: POST /api/votes. All model text is rendered as text.
import Link from "next/link";
import { recordText, spyCallText, stockVoteText, type Vote, type Votes } from "./productView";

const VOTE_TONE = { yes: "text-up", no: "text-down", none: "text-muted" } as const;
const TONE = {
  up: "bg-up-soft text-up",
  down: "bg-down-soft text-down",
  muted: "bg-line text-muted",
};
const voteWord = (vote: Vote["vote"]) =>
  vote === "none" ? "No answer" : vote === "yes" ? "Yes" : "No";

function StockVotes({ stock }: { stock: Votes["stocks"][number] }) {
  const total = stock.votes.length || 1;
  return (
    <li className="grid content-start gap-2 rounded-xl border border-line p-3">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
        <strong className="font-mono text-base">{stock.symbol}</strong>
        <span className="text-sm font-medium">{stockVoteText(stock)}</span>
      </p>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={`${stock.yes} yes, ${stock.no} no`}
      >
        <div className="bg-up" style={{ width: `${(stock.yes / total) * 100}%` }} />
        <div className="bg-down" style={{ width: `${(stock.no / total) * 100}%` }} />
      </div>
      <ul className="grid gap-1.5 text-sm">
        {stock.votes.map((vote) => (
          <li key={vote.agent}>
            <span className={`font-semibold ${VOTE_TONE[vote.vote]}`}>{voteWord(vote.vote)}</span>{" "}
            <span className="font-medium">{vote.agent}</span>
            {vote.vote !== "none" && <span className="text-muted">: {vote.reason}</span>}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function PanelSection({ votes }: { votes: Votes }) {
  const call = votes.beatsSpy;
  const said = call ? spyCallText(call) : null;
  return (
    <div className="grid gap-4">
      {call && said && (
        <div className="grid gap-3 rounded-xl bg-bg p-4">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-base font-semibold">{said.headline}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[said.tone]}`}>
              {said.verdict}
            </span>
          </p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {call.calls.map((item) => {
              const record = votes.records?.find((r) => r.agent === item.agent);
              return (
                <li key={item.agent} className="grid gap-0.5">
                  <p>
                    <span className={`font-semibold ${VOTE_TONE[item.vote]}`}>
                      {voteWord(item.vote)}
                    </span>{" "}
                    <span className="font-medium">{item.agent}</span>
                    {item.probability !== null && (
                      <span className="font-mono text-muted">
                        {" "}
                        · {Math.round(item.probability * 100)}% chance
                      </span>
                    )}
                  </p>
                  {item.vote !== "none" && <p className="text-muted">{item.reason}</p>}
                  <p>
                    <Link href="/track-record" className="font-mono text-xs text-blue underline">
                      {recordText(record)}
                    </Link>
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">
            Each agent&apos;s record is its share of right calls in the{" "}
            <Link href="/track-record" className="text-blue underline">
              track record
            </Link>
            , which also says what so short a record can and cannot show.
          </p>
        </div>
      )}
      <ul className="grid items-start gap-3 lg:grid-cols-3">
        {votes.stocks.map((stock) => (
          <StockVotes key={stock.symbol} stock={stock} />
        ))}
      </ul>
      <p className="text-xs text-muted">AI opinions, not financial advice.</p>
    </div>
  );
}
