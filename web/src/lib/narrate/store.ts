import { db } from "../db/client";

export type BriefingMeta = {
  basketId: string;
  script: string;
  mime: string;
  model: string;
  bytes: number;
  createdAt: string;
};

export type BriefingStore = {
  meta(basketId: string): Promise<BriefingMeta | null>;
  audio(basketId: string): Promise<{ audio: Buffer; mime: string } | null>;
  put(briefing: {
    basketId: string;
    script: string;
    audio: Buffer;
    mime: string;
    model: string;
    characterCost: number | null;
  }): Promise<BriefingMeta>;
};

type MetaRow = {
  basket_id: string;
  script: string;
  mime: string;
  model: string;
  bytes: number;
  created_at: Date;
};

const toMeta = (r: MetaRow): BriefingMeta => ({
  basketId: r.basket_id,
  script: r.script,
  mime: r.mime,
  model: r.model,
  bytes: r.bytes,
  createdAt: r.created_at.toISOString(),
});

export const tigerBriefingStore: BriefingStore = {
  async meta(basketId) {
    const rows = await db()<MetaRow[]>`
      select basket_id, script, mime, model, octet_length(audio)::int as bytes, created_at
      from briefings where basket_id = ${basketId}`;
    return rows[0] ? toMeta(rows[0]) : null;
  },

  async audio(basketId) {
    const rows = await db()<{ audio: Buffer; mime: string }[]>`
      select audio, mime from briefings where basket_id = ${basketId}`;
    return rows[0] ?? null;
  },

  async put(b) {
    const rows = await db()<MetaRow[]>`
      insert into briefings (basket_id, script, audio, mime, model, character_cost)
      values (${b.basketId}, ${b.script}, ${b.audio}, ${b.mime}, ${b.model}, ${b.characterCost})
      on conflict (basket_id) do update set
        script = excluded.script, audio = excluded.audio, mime = excluded.mime,
        model = excluded.model, character_cost = excluded.character_cost, created_at = now()
      returning basket_id, script, mime, model, octet_length(audio)::int as bytes, created_at`;
    return toMeta(rows[0]);
  },
};
