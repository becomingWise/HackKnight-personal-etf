// The hosted Lab: the copies of /experiment (scripts/sync-lab.mjs), the four /api/lab routes with
// the agent mocked, and the hand-off of a basket from the AI page (public/lab-own/bridge.js).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildHandoff, handoffNotice, parseHandoff } from "../../../public/lab-own/bridge.js";
import { restoreBasket } from "../../../public/lab-static/session.js";
import {
  DISCLAIMER,
  LAB_FILES,
  LAB_NAV_LINKS,
  labCopy,
  syncLab,
} from "../../../scripts/sync-lab.mjs";
import { labBasketUrl } from "../../app/consoleView";
import { NAV, DISCLAIMER as SITE_DISCLAIMER } from "../../app/productView";
import { ClarifyError } from "../agent-core/agent/gemini.js";
import { createSuggestionService } from "../agent-core/experiment/suggestions.js";
import { agentBudget } from "../agentApi/adapters";
import { memoryApiCache } from "../cache/apiCache";
import { memoryModelBudget } from "../gemini/budget";
import { createLabHandlers, labCache, type LabDeps, type LabSuggest } from "./handler";
import { snapshot } from "./snapshot";

const labDir = path.join(process.cwd(), "..", "experiment");
const hasLab = existsSync(path.join(labDir, "app.js"));

describe("pnpm sync:lab", () => {
  it("stops when the Lab no longer has the text a replacement expects", () => {
    const file = {
      from: "app.js",
      edits: [['"/api/', '"/api/lab/', 4]] as [string, string, number][],
    };
    expect(() => labCopy(file, Buffer.from('fetch("/api/overview")'))).toThrow(
      /expected .* 4 time/,
    );
    expect(labCopy({ from: "math.js" }, Buffer.from("x")).toString()).toBe("x");
  });

  // On Vercel only /web exists; the comparison runs wherever the repository root is present.
  it.skipIf(!hasLab)("the committed copies match /experiment (run `pnpm sync:lab`)", () => {
    for (const file of LAB_FILES) {
      // Compared as text without CRLF: a Windows checkout may convert either side.
      const text = (bytes: Buffer) => bytes.toString("utf8").replace(/\r\n/g, "\n");
      const expected = labCopy(file, readFileSync(path.join(labDir, file.from)));
      expect(text(readFileSync(file.to)) === text(expected), file.to).toBe(true);
    }
  });

  it.skipIf(!hasLab)("writes every copy once and nothing the second time", async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), "sync-lab-"));
    try {
      expect(await syncLab({ labDir, webDir })).toBe(LAB_FILES.length);
      expect(await syncLab({ labDir, webDir })).toBe(0);
      const app = readFileSync(path.join(webDir, "public/lab-static/app.js"), "utf8");
      expect(app).toContain('api("/api/lab/overview")');
      expect(app).toContain('navigate("/lab/basket")');
      expect(app).not.toMatch(/"\/(api\/(?!lab\/)|basket|events")/);
      expect(app.startsWith('import "../lab-own/bridge.js";')).toBe(true);
    } finally {
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it("the page links back to the AI page and carries the disclaimer", () => {
    const page = readFileSync("public/lab-static/index.html", "utf8");
    // The same header links as the rest of the site, with the Lab marked as the current page.
    expect(LAB_NAV_LINKS).toEqual(NAV.map((item) => [item.href, item.label]));
    for (const [href, label] of LAB_NAV_LINKS) {
      expect(page).toContain(
        `<a href="${href}"${href === "/lab" ? ' aria-current="page"' : ""}>${label}</a>`,
      );
    }
    expect(DISCLAIMER).toBe(SITE_DISCLAIMER);
    expect(page).toContain(DISCLAIMER);
    expect(DISCLAIMER).toBe(
      "Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket or Kalshi.",
    );
    expect(page).toContain('src="/lab-static/app.js"');
    // The Refresh button is hidden: the hosted Lab is read-only.
    expect(readFileSync("public/lab-own/lab-extra.css", "utf8")).toMatch(
      /#refresh\s*\{\s*display:\s*none/,
    );
  });
});

const allow = async () => ({ allowed: true, retryAfterSeconds: 0 });
const url = "https://prophetf.vercel.app/api/lab";
const get = (route: string) => new Request(`${url}/${route}`);
const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${url}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const never: LabSuggest = async () => {
  throw new Error("not expected");
};
const CHIPS = ["NVDA", "TSM", "AVGO", "AMD", "ASML", "MU", "INTC", "MSFT"];
const modelAnswer = (data: object) => ({
  candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(data) }] } }],
});
/** The Lab's own suggestion service on our budget and cache adapters, with Gemini mocked. */
const mockedService = (callModel: () => Promise<unknown>) =>
  createSuggestionService({
    callModel,
    cache: labCache(memoryApiCache()),
    budget: agentBudget(memoryModelBudget()),
  } as never) as unknown as LabSuggest;

describe("GET /api/lab/overview and /api/lab/events", () => {
  const lab = createLabHandlers({ snapshot, suggest: never, rateLimit: allow });

  it("overview lists the companies the Lab can price, from the committed snapshot", async () => {
    const response = await lab.overview(get("overview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.builtAt).toBe(snapshot.builtAt);
    expect(Date.parse(body.builtAt)).not.toBeNaN();
    expect(body).toMatchObject({ suggestionMode: "gemini", readOnly: true });
    const symbols = body.stocks.map((stock: { symbol: string }) => stock.symbol);
    expect(symbols).toContain("NVDA");
    // Funds are in the agent's universe but not in the Lab.
    for (const fund of ["TLT", "IEF", "LQD", "HYG", "SHY", "IBIT"]) {
      expect(symbols).not.toContain(fund);
    }
    const nvda = body.stocks.find((stock: { symbol: string }) => stock.symbol === "NVDA");
    expect(nvda.lastClose.close).toBeGreaterThan(0);
    expect(nvda.eventCount).toBeGreaterThan(0);
  });

  it("events returns one company's linked events and rejects other tickers", async () => {
    const ok = await lab.events(get("events?symbol=NVDA"));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.symbol).toBe("NVDA");
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0]).toHaveProperty("fit");
    expect(body.events[0].history).toBeUndefined();

    for (const route of ["events?symbol=TLT", "events"]) {
      const bad = await lab.events(get(route));
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("invalid_request");
    }
  });

  it("is rate limited per IP", async () => {
    const rateLimit = vi.fn<LabDeps["rateLimit"]>(async () => ({
      allowed: false,
      retryAfterSeconds: 7,
    }));
    const limited = createLabHandlers({ snapshot, suggest: never, rateLimit });
    const response = await limited.overview(get("overview"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(rateLimit.mock.calls[0][0][0].bucket).toMatch(/^lab:ip:/);
  });
});

describe("POST /api/lab/analysis", () => {
  const lab = createLabHandlers({ snapshot, suggest: never, rateLimit: allow });

  it("analyses a basket of 1 to 10 companies", async () => {
    const response = await lab.analysis(post("analysis", { symbols: ["NVDA", "TSM"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.builtAt).toBe(snapshot.builtAt);
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(["NVDA", "TSM"]);
    expect(body.basketHistory.length).toBeGreaterThan(60);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0].linkedHoldings.length).toBeGreaterThan(0);
  });

  it("rejects funds, empty baskets and bodies that are not JSON", async () => {
    for (const body of [{ symbols: ["TLT"] }, { symbols: [] }, {}, "not json"]) {
      const response = await lab.analysis(post("analysis", body));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
  });
});

describe("POST /api/lab/stocks", () => {
  it("returns 7 to 10 companies from the agent in Gemini mode, then reuses the answer", async () => {
    const callModel = vi.fn(async () =>
      modelAnswer({
        clarity: "clear",
        why: "Chip makers.",
        summary: "AI chip makers",
        symbols: CHIPS,
      }),
    );
    const lab = createLabHandlers({
      snapshot,
      suggest: mockedService(callModel),
      rateLimit: allow,
    });
    // A request cannot switch the hosted Lab to its keyword preview mode.
    const request = () =>
      post(
        "stocks",
        { idea: "AI chips", mode: "preview", preferences: [] },
        { "X-Session-Id": "tab-1" },
      );

    const first = await lab.stocks(request());
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    const body = await first.json();
    expect(body.source).toBe("gemini");
    expect(body.stocks.map((stock: { symbol: string }) => stock.symbol)).toEqual(CHIPS);
    expect(body.preferences).toEqual([]);
    expect(body).not.toHaveProperty("reused");
    expect(callModel).toHaveBeenCalledTimes(1);

    const second = await lab.stocks(request());
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("a three-stock answer is not accepted: the Lab's range is enforced", async () => {
    const callModel = vi.fn(async () =>
      modelAnswer({ clarity: "clear", why: "x", summary: "Chips", symbols: CHIPS.slice(0, 3) }),
    );
    const lab = createLabHandlers({
      snapshot,
      suggest: mockedService(callModel),
      rateLimit: allow,
    });
    const response = await lab.stocks(post("stocks", { idea: "AI chips" }));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await response.json()).stocks).toBeUndefined();
  });

  it("an unclear idea is 422 needs_clarification with options, as on /api/stocks", async () => {
    const callModel = vi.fn(async () =>
      modelAnswer({
        clarity: "broad",
        why: "Several themes.",
        symbols: [],
        question: "Which part of money do you mean?",
        options: ["Banks and interest rates", "Crypto companies", "Big Tech and AI"],
      }),
    );
    const lab = createLabHandlers({
      snapshot,
      suggest: mockedService(callModel),
      rateLimit: allow,
    });
    const response = await lab.stocks(post("stocks", { idea: "money" }));
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("needs_clarification");
    expect(error.message).toBe("Which part of money do you mean?");
    expect(error.options).toHaveLength(3);
    expect(callModel).toHaveBeenCalledTimes(1);

    // The free pre-check: no model call at all.
    const nonsense = await lab.stocks(post("stocks", { idea: "asdfgh" }));
    expect(nonsense.status).toBe(422);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("passes the session, the snapshot's events and a clarification's preferences through", async () => {
    const suggest = vi.fn<LabSuggest>(async () => {
      throw new ClarifyError(
        "Which theme?",
        ["Oil and energy supply", "Crypto companies"],
        ["no banks"],
      );
    });
    const lab = createLabHandlers({ snapshot, suggest, rateLimit: allow });
    const response = await lab.stocks(
      post("stocks", { idea: "things", preferences: ["no banks"] }, { "X-Session-Id": "tab-9" }),
    );
    expect((await response.json()).error.preferences).toEqual(["no banks"]);
    expect(suggest.mock.calls[0][0]).toEqual({
      idea: "things",
      mode: "gemini",
      preferences: ["no banks"],
    });
    expect(suggest.mock.calls[0][1]).toMatchObject({ sessionId: "tab-9", events: snapshot.events });
  });

  it("shares the per-IP limits of /api/stocks and validates the idea first", async () => {
    const rateLimit = vi.fn<LabDeps["rateLimit"]>(async () => ({
      allowed: false,
      retryAfterSeconds: 30,
    }));
    const lab = createLabHandlers({ snapshot, suggest: never, rateLimit });
    for (const body of [{}, { idea: "  " }, { idea: "x".repeat(501) }]) {
      const bad = await lab.stocks(post("stocks", body));
      expect(bad.status).toBe(400);
    }
    expect(rateLimit).not.toHaveBeenCalled();
    const limited = await lab.stocks(post("stocks", { idea: "AI chips" }));
    expect(limited.status).toBe(429);
    expect(
      rateLimit.mock.calls[0][0].map((limit) => limit.bucket.split(":").slice(0, 2).join(":")),
    ).toEqual(["findstocks:ip", "findstocks:ipday"]);
  });

  it("an unexpected failure is 502 without details", async () => {
    const lab = createLabHandlers({
      snapshot,
      suggest: async () => {
        throw new Error("postgres://secret");
      },
      rateLimit: allow,
    });
    const response = await lab.stocks(post("stocks", { idea: "AI chips" }));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});

describe("the hand-off from the AI page", () => {
  const catalog = [
    ...["NVDA", "TSM", "AMD", "XOM", "CVX", "JPM", "BAC", "LMT", "MSFT"].map((symbol) => ({
      symbol,
      name: `${symbol} Inc.`,
      lastClose: { date: "2026-10-09", close: 100 },
    })),
    { symbol: "MARA", name: "MARA Holdings", lastClose: null },
  ];
  const allowed = catalog.map((stock) => stock.symbol);

  it("the link carries the symbols and the idea", () => {
    const link = labBasketUrl(["NVDA", "TSM", "TLT"], " AI chips & Taiwan risk ");
    expect(link).toBe("/lab/basket?symbols=NVDA,TSM,TLT&idea=AI%20chips%20%26%20Taiwan%20risk");
    expect(parseHandoff(link.slice(link.indexOf("?")))).toEqual({
      symbols: ["NVDA", "TSM", "TLT"],
      idea: "AI chips & Taiwan risk",
    });
  });

  it("reads symbols tolerantly and ignores everything that is not a ticker", () => {
    expect(parseHandoff("?idea=x")).toBeNull();
    expect(parseHandoff("?symbols= nvda,TSM,,nvda,<script>,BRK.B,TOOLONGX")).toEqual({
      symbols: ["NVDA", "TSM", "BRK.B"],
      idea: "",
    });
    expect(parseHandoff(`?symbols=NVDA&idea=${"x".repeat(600)}`)?.idea).toHaveLength(500);
  });

  it("loads the symbols as a basket the Lab itself accepts", () => {
    const result = buildHandoff({ symbols: ["NVDA", "TSM", "AMD"], idea: "AI chips" }, catalog);
    expect(result.untradable).toEqual([]);
    const restored = restoreBasket(JSON.stringify(result.basket), allowed)!;
    expect(restored).not.toBeNull();
    expect(restored.symbols).toEqual(["NVDA", "TSM", "AMD"]);
    expect(restored.removed).toEqual([]);
    expect(restored.paperAmountCents).toBe(0);
    expect(restored.idea).toBe("AI chips");
    expect(handoffNotice(result)).toBe("Loaded NVDA, TSM, AMD from AI research.");
  });

  it("names funds as not tradable and keeps the rest", () => {
    const result = buildHandoff({ symbols: ["TLT", "JPM", "IBIT"], idea: "" }, catalog);
    expect(result.tradable).toEqual(["JPM"]);
    expect(result.untradable).toEqual(["TLT", "IBIT"]);
    expect(restoreBasket(JSON.stringify(result.basket), allowed)?.symbols).toEqual(["JPM"]);
    expect(handoffNotice(result)).toBe(
      "Loaded JPM from AI research. Not tradable in the Lab yet: TLT, IBIT.",
    );
  });

  it("a company without a price in the snapshot is not tradable either", () => {
    const result = buildHandoff({ symbols: ["MARA", "NVDA"], idea: "" }, catalog);
    expect(result.tradable).toEqual(["NVDA"]);
    expect(result.untradable).toEqual(["MARA"]);
    expect(result.basket?.candidates.map((c) => c.symbol)).not.toContain("MARA");
  });

  it("with nothing tradable there is no basket, and the notice says so", () => {
    const result = buildHandoff({ symbols: ["TLT", "IEF", "SHY"], idea: "bonds" }, catalog);
    expect(result.basket).toBeNull();
    expect(handoffNotice(result)).toBe(
      "None of these can be paper-traded in the Lab yet: TLT, IEF, SHY.",
    );
    expect(handoffNotice(buildHandoff({ symbols: [], idea: "" }, catalog))).toBe(
      "No stock symbols were handed over.",
    );
  });

  it("every fund of the agent's universe is outside the real Lab catalog", async () => {
    const lab = createLabHandlers({ snapshot, suggest: never, rateLimit: allow });
    const { stocks } = await (await lab.overview(get("overview"))).json();
    const result = buildHandoff(
      { symbols: ["TLT", "IEF", "LQD", "HYG", "SHY", "IBIT", "XOM"], idea: "" },
      stocks,
    );
    expect(result.tradable).toEqual(["XOM"]);
    expect(result.untradable).toEqual(["TLT", "IEF", "LQD", "HYG", "SHY", "IBIT"]);
  });
});
