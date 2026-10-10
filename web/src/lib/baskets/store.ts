import { randomInt } from "node:crypto";
import { db } from "../db/client";
import type { Basket } from "./schema";

export type StoredBasket = Omit<Basket, "url">;

export type BasketStore = {
  /** Saves under a new short id and returns it with the creation time. */
  insert(
    basket: Omit<Basket, "id" | "url" | "createdAt">,
    creator: string,
  ): Promise<{
    id: string;
    createdAt: string;
  }>;
  get(id: string): Promise<StoredBasket | null>;
};

// No look-alike characters (0/O, 1/l/I), so ids survive being read aloud or retyped.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const BASKET_ID_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export function newBasketId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

type Row = {
  id: string;
  idea: string;
  summary: string;
  source: Basket["source"];
  stocks: Basket["stocks"];
  weights: Basket["weights"];
  markets: Basket["markets"];
  created_at: Date;
};

export const tigerBasketStore: BasketStore = {
  async insert(basket, creator) {
    const sql = db();
    const marketIds = [...new Set(basket.markets.flatMap((m) => (m.id ? [m.id] : [])))];
    for (let attempt = 0; ; attempt++) {
      const id = newBasketId();
      const rows = await sql<{ created_at: Date }[]>`
        insert into baskets (id, idea, summary, source, stocks, weights, markets, market_ids, creator)
        values (
          ${id}, ${basket.idea}, ${basket.summary}, ${basket.source},
          ${sql.json(basket.stocks)}, ${sql.json(basket.weights)}, ${sql.json(basket.markets)},
          ${marketIds}, ${creator}
        )
        on conflict (id) do nothing
        returning created_at`;
      if (rows.length) return { id, createdAt: rows[0].created_at.toISOString() };
      if (attempt >= 3) throw new Error("Could not allocate a basket id");
    }
  },

  async get(id) {
    const rows = await db()<Row[]>`
      select id, idea, summary, source, stocks, weights, markets, created_at
      from baskets where id = ${id}`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      idea: row.idea,
      summary: row.summary,
      source: row.source,
      stocks: row.stocks,
      weights: row.weights,
      markets: row.markets,
    };
  },
};
