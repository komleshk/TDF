export const ACTIONS = ["Hold", "Redeem", "Switch", "Stop SIP", "Continue SIP", "Review"];

export function recommendationFor(holding, holdings, settings = {}) {
  const smallThreshold = Number(settings.smallHoldingThreshold || 25000);
  const sameCategory = holdings.filter((item) => item.category === holding.category);
  const reasons = [];
  let action = "Hold";

  if (holding.isElss) {
    action = holding.sip ? "Stop SIP" : "Review";
    reasons.push("Stop fresh SIP and review the applicable three-year lock-in before any redemption.");
  }
  if (holding.currentValue > 0 && holding.currentValue < smallThreshold) {
    action = action === "Hold" ? "Review" : action;
    reasons.push("Small-value holding may be considered for consolidation.");
  }
  if (sameCategory.length > 1 && !/liquid|overnight/i.test(holding.category)) {
    action = action === "Hold" ? "Review" : action;
    reasons.push(`${sameCategory.length} holdings share this category; review overlap and rationalisation.`);
  }
  if (/sector|thematic/i.test(holding.category)) {
    action = "Review";
    reasons.push("Sector/thematic exposure needs a suitable risk appetite and longer time horizon.");
  }
  if (holding.assetClass === "Debt") {
    action = action === "Hold" ? "Review" : action;
    reasons.push("Review debt holdings separately for duration, credit quality, liquidity and goal alignment.");
  }
  if (Array.isArray(settings.categoriesToAvoid) && settings.categoriesToAvoid.some((category) => category.toLowerCase() === holding.category.toLowerCase())) {
    action = "Review";
    reasons.push("This category is on the distributor's configured avoid/review list.");
  }
  if (Array.isArray(settings.recommendedFunds) && settings.recommendedFunds.length && !settings.recommendedFunds.some((fund) => holding.schemeName.toLowerCase().includes(String(fund).toLowerCase()))) {
    action = action === "Hold" ? "Review" : action;
    reasons.push("The scheme is not on the distributor's current recommended fund list.");
  }
  if (["Redeem", "Switch"].includes(action)) {
    reasons.push("Check taxation and exit load before execution.");
  }
  if (!reasons.length) reasons.push("No structural exception was identified by the rule-based review; validate suitability against the client's goals.");

  return {
    holdingKey: holding.key,
    systemAction: action,
    systemReason: reasons.join(" "),
    finalAction: action,
    clientNote: "",
    internalNote: "",
  };
}

export function buildRecommendations(holdings, settings) {
  return holdings.map((holding) => recommendationFor(holding, holdings, settings));
}
