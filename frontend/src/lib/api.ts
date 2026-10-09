export type Window = "1d" | "1w" | "1m";

export type Sector = {
  id: string;
  name: string;
  blurb: string;
  holdings: { symbol: string; name: string; base: number }[];
};

export type Contribution = { signal: string; beta: number; delta: number; effect: number };

export type Holding = {
  symbol: string;
  name: string;
  sector: string;
  multiplier: number;
  base_pct: number;
  weight_pct: number;
  change_pct: number;
  contributions: Contribution[];
};

export type Move = { now: number; ref: number; live: number; delta: number };

export type Signal = {
  id: string;
  label: string;
  status: "live" | "unavailable";
  question?: string;
  url?: string;
  price: number | null;
  changes?: Record<Window, number | null>;
  volume?: number;
  end_date?: string;
  betas: Record<string, number>;
  move: Move | null;
};

export type Suggestion = {
  sector: string;
  name: string;
  score: number;
  driver: string;
  driver_label: string;
  driver_delta: number;
};

export type Basket = {
  as_of: string;
  holdings: Holding[];
  signals: Signal[];
  suggestions: Suggestion[];
};

export type TicketLine = {
  symbol: string;
  name: string;
  weight_pct: number;
  dollars: number;
  price: number | null;
  units: number | null;
};

export type Ticket = { as_of: string; amount: number; lines: TicketLine[]; simulated: true };

export type BasketParams = {
  scope: string[];
  window: Window;
  sensitivity: number;
  overrides: Record<string, number>;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).then(json<T>);
}

export const api = {
  sectors: () => fetch("/api/sectors").then(json<Sector[]>),
  basket: (p: BasketParams, signal?: AbortSignal) => post<Basket>("/api/basket", p, signal),
  ticket: (p: BasketParams & { amount: number }) => post<Ticket>("/api/ticket", p),
  history: (id: string, interval: "1d" | "1w" | "1m" = "1m") =>
    fetch(`/api/signals/${id}/history?interval=${interval}`).then(json<{ history: { t: number; p: number }[] }>),
};
