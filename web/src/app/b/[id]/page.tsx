// /b/{id}: the share page of a saved basket. It only reads what is stored: the basket, its
// manager's note if one was written, and whether a briefing exists. Opening it makes no Gemini
// or ElevenLabs call; Listen makes the briefing on click. The JSON is at GET /api/baskets/{id}.
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BASKET_ID_PATTERN, tigerBasketStore } from "@/lib/baskets/store";
import { tigerApiCache } from "@/lib/cache/apiCache";
import { letterCacheKey, type CachedLetter } from "@/lib/letter/handler";
import { tigerBriefingStore } from "@/lib/narrate/store";
import { labBasketUrl, weekMove, yesNo } from "../../consoleView";
import { safeLink, weightText } from "../../productView";
import { Listen } from "../../share";

export const metadata: Metadata = { title: "A saved basket" };

const PANEL = "rounded-panel border border-line bg-surface p-5 sm:p-6";
const EYEBROW = "text-xs font-semibold tracking-[0.18em] text-blue";

function Message({ title, text }: { title: string; text: string }) {
  return (
    <section className={PANEL}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted">{text}</p>
      <Link href="/" className="mt-5 inline-block text-blue underline">
        Build a basket
      </Link>
    </section>
  );
}

async function SavedBasket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!BASKET_ID_PATTERN.test(id)) {
    return <Message title="This basket does not exist." text="Check the link and try again." />;
  }
  let basket, letter, briefing;
  try {
    basket = await tigerBasketStore.get(id);
    if (basket) {
      [letter, briefing] = await Promise.all([
        tigerApiCache.get<CachedLetter>("letter", letterCacheKey(id)).catch(() => null),
        tigerBriefingStore.meta(id).catch(() => null),
      ]);
    }
  } catch {
    return (
      <Message
        title="We could not load this basket right now."
        text="Please try again in a moment."
      />
    );
  }
  if (!basket) {
    return <Message title="This basket does not exist." text="Check the link and try again." />;
  }

  const saved = new Date(basket.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const evidence = basket.weights.evidence;
  return (
    <div className="grid gap-5">
      <section className={PANEL}>
        <p className={EYEBROW}>SAVED BASKET · {saved}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{basket.idea}</h1>
        <p className="mt-2 text-muted">{basket.summary}</p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {basket.stocks.map((stock) => (
            <li key={stock.symbol} className="rounded-xl border border-line p-4">
              <p className="flex items-baseline justify-between gap-2">
                <strong className="font-mono text-lg">{stock.symbol}</strong>
                <span className="font-mono text-2xl font-semibold">
                  {weightText(stock.weightPct)}
                </span>
              </p>
              <p className="text-sm text-muted">{stock.name}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          A saved basket never changes: these are the weights and the odds of the day it was saved.
        </p>
      </section>

      {evidence.length > 0 && (
        <section className={PANEL}>
          <p className={EYEBROW}>POLYMARKET ODDS WHEN IT WAS SAVED</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {evidence.map((market) => {
              const link = safeLink(market.url);
              const move = weekMove(market.change7d);
              return (
                <li key={market.url + market.title} className="rounded-xl border border-line p-3">
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue hover:underline"
                    >
                      {market.title}
                    </a>
                  ) : (
                    <span className="font-medium">{market.title}</span>
                  )}
                  <p className="mt-1 font-mono text-sm">
                    YES {yesNo(market.probability).yes}%{" "}
                    <span className="text-muted">· {move.text}</span>
                  </p>
                  {market.symbols.length > 0 && (
                    <p className="mt-1 text-xs text-muted">Affects {market.symbols.join(", ")}</p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Event probabilities indicate risk, not expected returns.
          </p>
        </section>
      )}

      <section className={PANEL}>
        <p className={EYEBROW}>MANAGER&apos;S NOTE</p>
        {letter ? (
          <p className="mt-2 whitespace-pre-line">{letter.value.letter}</p>
        ) : (
          <p className="mt-2 text-muted">No note has been written for this basket.</p>
        )}
        <div className="mt-4">
          {briefing ? (
            <div className="grid gap-1">
              <audio controls preload="none" src={`/api/audio/${id}`} className="w-full max-w-md">
                Your browser cannot play this audio.
              </audio>
              <p className="text-xs text-muted">The briefing, read aloud by ElevenLabs.</p>
            </div>
          ) : (
            <Listen id={id} />
          )}
        </div>
      </section>

      <p className="flex flex-wrap gap-3">
        <a
          href={labBasketUrl(
            basket.stocks.map((stock) => stock.symbol),
            basket.idea,
          )}
          className="rounded-full bg-blue px-4 py-2 text-sm font-semibold text-surface hover:opacity-90"
        >
          Paper-trade this basket →
        </a>
        <Link
          href="/"
          className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:border-blue hover:text-blue"
        >
          Build your own
        </Link>
      </p>
    </div>
  );
}

export default function SharedBasketPage(props: PageProps<"/b/[id]">) {
  return (
    <Suspense
      fallback={
        <p role="status" className={`${PANEL} text-muted`}>
          Loading the basket…
        </p>
      }
    >
      <SavedBasket params={props.params} />
    </Suspense>
  );
}
