function groupByValue(holdings, field) {
  const total = holdings.reduce((sum, holding) => sum + holding.currentValue, 0);
  return Object.entries(
    holdings.reduce((groups, holding) => {
      const key = holding[field] || "Unclassified";
      groups[key] = (groups[key] || 0) + holding.currentValue;
      return groups;
    }, {}),
  )
    .map(([name, value]) => ({ name, value, percent: total ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

export function xirr(transactions) {
  const cashflows = transactions
    .filter((tx) => tx.date && Number.isFinite(Number(tx.amount)))
    .map((tx) => ({ date: new Date(tx.date), amount: Number(tx.amount) }))
    .filter((tx) => !Number.isNaN(tx.date.valueOf()));
  if (cashflows.length < 2 || !cashflows.some((tx) => tx.amount < 0) || !cashflows.some((tx) => tx.amount > 0)) return null;
  const origin = cashflows[0].date;
  const valueAt = (rate) =>
    cashflows.reduce(
      (sum, tx) => sum + tx.amount / (1 + rate) ** ((tx.date - origin) / 86_400_000 / 365),
      0,
    );
  let low = -0.9999;
  let high = 10;
  for (let index = 0; index < 100; index += 1) {
    const mid = (low + high) / 2;
    if (valueAt(mid) > 0) low = mid;
    else high = mid;
  }
  const result = (low + high) / 2;
  return Number.isFinite(result) ? result * 100 : null;
}

export function buildAnalytics(holdings, settings = {}) {
  const totalValue = holdings.reduce((sum, item) => sum + item.currentValue, 0);
  const totalCost = holdings.reduce((sum, item) => sum + item.costValue, 0);
  const byAssetClass = groupByValue(holdings, "assetClass");
  const byAmc = groupByValue(holdings, "amc");
  const byCategory = groupByValue(holdings, "category");
  const smallThreshold = Number(settings.smallHoldingThreshold || 25000);
  const concentrationThreshold = Number(settings.concentrationThreshold || 20);
  const topHoldings = [...holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, 10);
  const categoryCounts = holdings.reduce((counts, holding) => {
    counts[holding.category] = (counts[holding.category] || 0) + 1;
    return counts;
  }, {});
  const allTransactions = holdings.flatMap((holding) => holding.transactions || []);

  return {
    totalValue,
    totalCost,
    absoluteGain: totalValue - totalCost,
    gainPercent: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    xirr: xirr(allTransactions),
    byAssetClass,
    byAmc,
    byCategory,
    topHoldings,
    smallHoldings: holdings.filter((holding) => holding.currentValue > 0 && holding.currentValue < smallThreshold),
    duplicateCategories: Object.entries(categoryCounts)
      .filter(([, count]) => count > 1)
      .map(([category, count]) => ({ category, count })),
    elss: holdings.filter((holding) => holding.isElss),
    thematic: holdings.filter((holding) => /sector|thematic/i.test(holding.category)),
    concentrated: topHoldings.filter((holding) => totalValue && (holding.currentValue / totalValue) * 100 >= concentrationThreshold),
    sips: holdings.filter((holding) => holding.sip).map((holding) => ({ schemeName: holding.schemeName, ...holding.sip })),
    stps: holdings.filter((holding) => holding.stp).map((holding) => ({ schemeName: holding.schemeName, ...holding.stp })),
    swps: holdings.filter((holding) => holding.swp).map((holding) => ({ schemeName: holding.schemeName, ...holding.swp })),
  };
}
