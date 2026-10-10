// Pure calculation functions: no DOM, network calls, or actual trades.
export function validateBasket(input, assets) {
  const errors = [];
  if (!input || !Number.isFinite(input.budget) || input.budget <= 0) {
    errors.push("Enter a pretend budget greater than $0.");
  }
  const holdings = input?.holdings;
  if (!Array.isArray(holdings)) return [...errors, "Choose three to five companies."];
  if (holdings.length < 3 || holdings.length > 5) errors.push("Choose three to five companies.");
  const catalog = new Map(assets.map(asset => [asset.id, asset]));
  const ids = new Set();
  let total = 0;
  for (const holding of holdings) {
    const asset = catalog.get(holding.assetId);
    if (!asset) errors.push(`Unknown company: ${holding.assetId}.`);
    else if (!Number.isFinite(asset.price) || asset.price <= 0) errors.push(`${asset.name} needs a positive mock price.`);
    if (ids.has(holding.assetId)) errors.push("Select each company only once.");
    ids.add(holding.assetId);
    if (!Number.isFinite(holding.weightPct) || holding.weightPct <= 0 || holding.weightPct > 100) {
      errors.push(`${asset?.name ?? "Each company"} needs a weight greater than 0% and at most 100%.`);
    } else total += holding.weightPct;
  }
  if (holdings.length && Math.abs(total - 100) > 0.010000001) {
    errors.push(`Your weights total ${total.toFixed(2)}%. Adjust them to 100%, or choose Equal weights.`);
  }
  return [...new Set(errors)];
}

export function equalWeightHoldings(assetIds) {
  if (!assetIds.length) return [];
  const base = Math.floor(10000 / assetIds.length);
  return assetIds.map((assetId, index) => ({
    assetId,
    weightPct: (index === assetIds.length - 1 ? 10000 - base * index : base) / 100
  }));
}

export function calculateBasket(input, assets) {
  const errors = validateBasket(input, assets);
  if (errors.length) throw new Error(errors.join(" "));
  const catalog = new Map(assets.map(asset => [asset.id, asset]));
  const total = input.holdings.reduce((sum, holding) => sum + holding.weightPct, 0);
  const interestWeights = {};
  const holdings = input.holdings.map(holding => {
    const asset = catalog.get(holding.assetId);
    // Normalize a rounding difference of up to 0.01% so the full budget is allocated.
    const weightPct = holding.weightPct / total * 100;
    const dollars = input.budget * (weightPct / 100);
    interestWeights[asset.interest] = (interestWeights[asset.interest] ?? 0) + weightPct;
    return { ...asset, weightPct, dollars, units: dollars / asset.price };
  });
  return {
    budget: input.budget,
    holdings,
    interestWeights,
    largestWeightPct: Math.max(...holdings.map(holding => holding.weightPct))
  };
}

export function applyScenario(result, changesPctByAssetId = {}) {
  const ids = new Set(result.holdings.map(holding => holding.id));
  for (const [id, change] of Object.entries(changesPctByAssetId)) {
    if (!ids.has(id)) throw new Error(`Unknown scenario company: ${id}.`);
    if (!Number.isFinite(change) || change < -100) throw new Error("Price changes must be finite numbers of at least -100%.");
  }
  const holdings = result.holdings.map(holding => {
    const changePct = changesPctByAssetId[holding.id] ?? 0;
    const scenarioPrice = holding.price * (1 + changePct / 100);
    return { ...holding, changePct, scenarioPrice, scenarioValue: holding.units * scenarioPrice };
  });
  const scenarioValue = holdings.reduce((sum, holding) => sum + holding.scenarioValue, 0);
  return { holdings, scenarioValue, changePct: (scenarioValue / result.budget - 1) * 100 };
}
