function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Cancelled")); return; }
    const cancel = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function matches(idea, keyword) {
  // Latin terms use word boundaries; CJK examples match without spaces.
  if (/[^\p{Script=Latin}\s-]/u.test(keyword)) return idea.includes(keyword);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${keyword}($|[^\\p{L}\\p{N}])`, "u").test(idea);
}

/** Demo adapters only. Replace these two methods with backend adapters later. */
export function createMockServices({ loadFixtures, wait = pause } = {}) {
  let fixtures;
  const load = loadFixtures ?? (async () => {
    const response = await fetch(new URL("../data/chat-demo.json", import.meta.url));
    if (!response.ok) throw new Error("Could not load demo responses.");
    return response.json();
  });
  const getFixtures = async () => {
    fixtures ??= await load();
    return fixtures;
  };
  const choose = (data, idea) => {
    const text = idea.toLocaleLowerCase();
    return data.themes.find(theme => theme.keywords.some(keyword => matches(text, keyword))) ?? data.generic;
  };
  return {
    async findStocks({ idea }, { signal } = {}) {
      const data = await getFixtures();
      await wait(450, signal);
      const fixture = choose(data, idea);
      return structuredClone({ summary: fixture.summary, stocks: fixture.stocks });
    },
    async adjustWeights({ idea, holdings }, { signal } = {}) {
      const data = await getFixtures();
      await wait(700, signal);
      const fixture = choose(data, idea);
      if (fixture === data.generic) return {
        status: "unchanged", holdings: structuredClone(holdings), evidence: [],
        explanation: "This is a generic sample basket. No market lookup was performed, so the starting percentages are unchanged."
      };
      return {
        status: "adjusted", evidence: [],
        holdings: holdings.map((holding, index) => ({ symbol: holding.symbol, weightPct: [50, 30, 20][index] })),
        explanation: "Simulated adjustment: 50% / 30% / 20% shows how the Polymarket teammate’s adapter will connect. These are fixed demo percentages, not real market signals or a weighting formula."
      };
    }
  };
}
