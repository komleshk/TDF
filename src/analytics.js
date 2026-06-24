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
    .filter((tx) => !Number.isNaN(tx.date.valueOf()))
    .sort((a, b) => a.date - b.date);
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

function datedCashflows(transactions = []) {
  return transactions
    .filter((tx) => tx.date && Number.isFinite(Number(tx.amount)) && Number(tx.amount) !== 0)
    .map((tx) => ({ date: new Date(tx.date), amount: Number(tx.amount) }))
    .filter((tx) => !Number.isNaN(tx.date.valueOf()))
    .sort((a, b) => a.date - b.date);
}

function returnCashflows(holding, statementDate) {
  const flows = datedCashflows(holding.transactions);
  if (!flows.length || !holding.currentValue) return flows;
  const valuationDate = new Date(statementDate || Date.now());
  if (Number.isNaN(valuationDate.valueOf())) return flows;
  const sameDayTerminal = flows.some(
    (flow) =>
      flow.amount > 0 &&
      flow.date.toISOString().slice(0, 10) === valuationDate.toISOString().slice(0, 10) &&
      Math.abs(flow.amount - holding.currentValue) < 0.01,
  );
  if (!sameDayTerminal) flows.push({ date: valuationDate, amount: holding.currentValue });
  return flows.sort((a, b) => a.date - b.date);
}

function cagrForHolding(holding, statementDate) {
  const flows = datedCashflows(holding.transactions);
  const purchases = flows.filter((flow) => flow.amount < 0);
  const valuationDate = new Date(statementDate || Date.now());
  const otherPositiveFlows = flows.filter(
    (flow) =>
      flow.amount > 0 &&
      !(
        !Number.isNaN(valuationDate.valueOf()) &&
        flow.date.toISOString().slice(0, 10) === valuationDate.toISOString().slice(0, 10) &&
        Math.abs(flow.amount - holding.currentValue) < 0.01
      ),
  );
  if (purchases.length !== 1 || otherPositiveFlows.length || !holding.currentValue) return null;
  const end = new Date(statementDate || Date.now());
  const years = (end - purchases[0].date) / 86_400_000 / 365;
  if (!Number.isFinite(years) || years <= 0) return null;
  const invested = Math.abs(purchases[0].amount);
  if (!invested) return null;
  const result = ((holding.currentValue / invested) ** (1 / years) - 1) * 100;
  return Number.isFinite(result) ? result : null;
}

function holdingReturn(holding, statementDate) {
  const sourceFlows = datedCashflows(holding.transactions);
  const flows = returnCashflows(holding, statementDate);
  const firstInvestmentDate = sourceFlows.find((flow) => flow.amount < 0)?.date;
  return {
    key: holding.key,
    xirr: xirr(flows),
    cagr: cagrForHolding(holding, statementDate),
    firstInvestmentDate: firstInvestmentDate ? firstInvestmentDate.toISOString().slice(0, 10) : null,
    cashflowCount: sourceFlows.length,
    status: sourceFlows.some((flow) => flow.amount < 0) ? "calculated" : "missing-cashflows",
  };
}

export function buildAnalytics(holdings, settings = {}, statementDate = null) {
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
  const holdingReturns = holdings.map((holding) => holdingReturn(holding, statementDate));
  const portfolioTransactions = holdings.flatMap((holding) => returnCashflows(holding, statementDate));

  return {
    totalValue,
    totalCost,
    absoluteGain: totalValue - totalCost,
    gainPercent: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    xirr: xirr(portfolioTransactions),
    holdingReturns,
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
