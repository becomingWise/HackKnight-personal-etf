import type { Metadata } from "next";
import { PIPELINE } from "../productView";
import { LiveTech } from "./liveTech";

export const metadata: Metadata = {
  title: "How it works",
  description: "From an idea to a stock basket: the pipeline and the technology behind ProphETF.",
};

export default function HowItWorksPage() {
  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h1>
        <p className="max-w-3xl text-muted">
          You type an idea. An AI agent picks three stocks for it, live prediction-market odds set
          their weights, five more agents vote, and every call is scored a week later. Nothing is
          bought or sold: these are paper portfolios.
        </p>
      </section>

      <section aria-labelledby="pipeline-title" className="grid gap-3">
        <h2 id="pipeline-title" className="text-xl font-semibold">
          From idea to basket
        </h2>
        {/* The diagram: a row of boxes joined by arrows on a wide screen, a list on a phone. */}
        <ol className="grid gap-x-3 gap-y-3 sm:grid-cols-2 lg:grid-cols-7">
          {PIPELINE.map((step, index) => (
            <li
              key={step.title}
              className="relative rounded-xl border border-line bg-surface p-3 text-sm"
            >
              <p className="font-mono text-xs text-blue">{index + 1}</p>
              <p className="font-semibold">{step.title}</p>
              <p className="mt-1 text-muted">{step.text}</p>
              {index < PIPELINE.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 -right-3 z-10 hidden -translate-y-1/2 text-muted lg:block"
                >
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="tech-title" className="grid gap-3">
        <h2 id="tech-title" className="text-xl font-semibold">
          What it is built with
        </h2>
        <LiveTech />
      </section>
    </div>
  );
}
