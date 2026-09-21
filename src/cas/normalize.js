export function amount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return Number(String(value || "").replace(/[₹,\s]/g, "")) || 0;
}

export function inferAssetClass(scheme = "", category = "") {
  const text = `${scheme} ${category}`.toLowerCase();
  if (/gold|silver/.test(text)) return "Gold/Silver";
  if (/international|global|nasdaq|overseas|us equity/.test(text)) return "International";
  if (/liquid|overnight|money market|gilt|bond|debt|duration|credit risk|floater/.test(text)) return "Debt";
  if (/hybrid|balanced|multi asset|arbitrage|equity savings/.test(text)) return "Hybrid";
  if (/equity|cap|elss|tax saver|sector|thematic|index|focused|value|contra/.test(text)) return "Equity";
  return "Other";
}

export function inferCategory(scheme = "") {
  const text = scheme.toLowerCase();
  const pairs = [
    ["ELSS", /elss|tax saver|tax plan/],
    ["Sector/Thematic", /sector|thematic|technology|pharma|banking|infrastructure|consumption/],
    ["Small Cap", /small cap/],
    ["Mid Cap", /mid cap/],
    ["Large & Mid Cap", /large.*mid|mid.*large/],
    ["Large Cap", /large cap|bluechip/],
    ["Flexi Cap", /flexi cap|multi cap/],
    ["Index", /index|nifty|sensex/],
    ["Gold/Silver", /gold|silver/],
    ["Liquid/Overnight", /liquid|overnight/],
    ["Debt", /debt|bond|gilt|duration|credit risk|floater/],
    ["Hybrid", /hybrid|balanced|multi asset|arbitrage|equity savings/],
  ];
  return pairs.find(([, pattern]) => pattern.test(text))?.[0] || "Unclassified";
}

export function normalizeHolding(raw, index = 0) {
  const schemeName = String(raw.schemeName || raw.scheme || "Unidentified scheme").trim();
  const category = String(raw.category || inferCategory(schemeName)).trim();
  const currentValue = amount(raw.currentValue);
  const costValue = amount(raw.costValue);
  const units = amount(raw.units);
  return {
    key: raw.key || `${String(raw.folio || "folio").replace(/\W/g, "")}-${index + 1}`,
    folio: String(raw.folio || "").trim(),
    amc: String(raw.amc || "Unknown AMC").trim(),
    schemeName,
    assetClass: raw.assetClass || inferAssetClass(schemeName, category),
    category,
    option: raw.option || (/idcw|dividend/i.test(schemeName) ? "IDCW" : "Growth"),
    currentValue,
    costValue,
    units,
    nav: amount(raw.nav) || (units ? currentValue / units : 0),
    absoluteGain: currentValue - costValue,
    investor: raw.investor || null,
    transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    sip: raw.sip || null,
    stp: raw.stp || null,
    swp: raw.swp || null,
    isElss: raw.isElss ?? /elss|tax saver|tax plan/i.test(`${schemeName} ${category}`),
    lockInStatus: raw.lockInStatus || null,
    exitLoadNote: raw.exitLoadNote || null,
    taxNote: raw.taxNote || null,
  };
}
