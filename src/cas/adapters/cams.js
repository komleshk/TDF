import { GenericCasAdapter } from "./generic.js";
import { amount } from "../normalize.js";

const monthMap = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

const money = String.raw`[\d,]+(?:\.\d+)?`;
const panPattern = String.raw`[A-Z]{5}[0-9]{4}[A-Z]`;
const dematMarker = String.raw`\(\s*(?:Non\s*[-–]?\s*)?Demat\s*\)\s*-\s*ISIN\s*:`;
const schemeHeader = new RegExp(String.raw`PAN:\s*(?:OK\s+)?([A-Z0-9]+)\s*-\s*([\s\S]*?)\s+${dematMarker}\s*([A-Z0-9]+)`, "gi");

function toIsoDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const normalizedMonth = monthMap[month.toLowerCase()];
  return normalizedMonth ? `${year}-${normalizedMonth}-${day.padStart(2, "0")}` : "";
}

function cleanSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function plausibleInvestorName(value) {
  const cleaned = cleanSpaces(value).replace(/^(?:Mr|Mrs|Ms|Miss|M\/s)\.?\s+/i, "");
  if (cleaned.length < 2 || cleaned.length > 80) return "";
  if (/[0-9@]/.test(cleaned)) return "";
  if (cleaned.split(/\s+/).length > 6) return "";
  if (/mutual fund|statement|account|folio|transaction|scheme|nominee|address|email|mobile|amount|price|units|date|cams|kfin|password/i.test(cleaned)) return "";
  return cleaned;
}

function extractInvestorName(text) {
  const compact = cleanSpaces(text);
  const boundary = String.raw`(?=\s+(?:PAN|Email|E-mail|Mobile|Address|Folio|Statement|CAS|KYC|Nominee|Joint|Mode|Tax|Bank|Scheme)\b|[,|/]|$)`;
  const patterns = [
    new RegExp(String.raw`(?:Investor\s+Name|Unit\s+Holder\s+Name|Name\s+of\s+(?:Sole\s*/\s*)?First\s+Unit\s+Holder|Name\s+of\s+the\s+Investor|Name)\s*:?\s*((?:Mr|Mrs|Ms|Miss|M/s)?\.?\s*[A-Za-z][A-Za-z .'\-]{1,80}?)${boundary}`, "i"),
    new RegExp(String.raw`Dear\s+((?:Mr|Mrs|Ms|Miss)?\.?\s*[A-Za-z][A-Za-z .'\-]{1,80}?)(?:,|\s+PAN\b)`, "i"),
    new RegExp(String.raw`\b((?:Mr|Mrs|Ms|Miss)\.?\s+[A-Za-z][A-Za-z .'\-]{1,80}?)\s+PAN\s*:`, "i"),
  ];
  for (const pattern of patterns) {
    const matches = [...compact.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
    for (const match of matches.reverse()) {
      const name = plausibleInvestorName(match[1]);
      if (name) return name;
    }
  }
  return "";
}

function extractInvestorPan(text) {
  const pans = [...String(text || "").matchAll(new RegExp(String.raw`\b${panPattern}\b`, "g"))].map((match) => match[0]);
  return pans.at(-1) || "";
}

function accountKey(investor, index) {
  return investor.pan || investor.name.toLowerCase() || `account-${index}`;
}

function cleanSchemeName(value) {
  return cleanSpaces(value)
    .replace(new RegExp(String.raw`\s+${dematMarker}[\s\S]*$`, "i"), "")
    .split(/\s+(?:Advisor|Registrar|Folio\s+No\.?|Nominee|Opening\s+Unit\s+Balance|Date\s+Amount\s+Price\s+Units\s+Transaction|CAMSCASWS)\b/i)[0]
    .trim();
}

function lastMutualFundName(text) {
  const matches = [...text.matchAll(/([A-Z][A-Za-z&.\-\s]+Mutual Fund)\s+PAN:/gi)];
  return cleanSpaces(matches.at(-1)?.[1] || "Unknown AMC");
}

function folioDetails(block) {
  const compact = cleanSpaces(block);
  const match = compact.match(new RegExp(String.raw`\bFolio\s+No\.?:\s*([0-9][0-9\s/]{2,30})\s+(${panPattern}|[A-Za-z][A-Za-z .'\-]{1,80}?)(?:\s+PAN\s*:?\s*(${panPattern}))?(?=\s+(?:Nominee|Mode|Opening\s+Unit\s+Balance|\d{2}-[A-Za-z]{3}-\d{4}|CAMSCASWS|Date\s+Amount)|$)`, "i"));
  const fallbackFolio = compact.match(/\bFolio\s+No\.?:\s*([0-9][0-9\s/]{2,30})/i)?.[1] || compact.match(/\bFolio:\s*([0-9/]+)/i)?.[1] || "";
  const holder = cleanSpaces(match?.[2] || "");
  const holderPan = holder.match(new RegExp(String.raw`^${panPattern}$`, "i"))?.[0]?.toUpperCase() || match?.[3]?.toUpperCase() || "";
  return {
    folio: cleanSpaces(match?.[1] || fallbackFolio).replace(/\s*\/\s*/g, "/"),
    name: holderPan || plausibleInvestorName(holder),
    pan: holderPan,
  };
}

function parseTransactions(block) {
  const transactions = [];
  const transactionPattern = new RegExp(
    String.raw`\b(\d{2}-[A-Za-z]{3}-\d{4})\s+(${money})\s+(${money})\s+(-?${money})\s+([A-Za-z][\s\S]*?)(?=\s+\d{2}-[A-Za-z]{3}-\d{4}\s+${money}\s+${money}\s+-?${money}\s+[A-Za-z]|Closing Unit Balance:|NAV on|\z)`,
    "gi",
  );
  for (const match of block.matchAll(transactionPattern)) {
    const [, date, value, , , description] = match;
    const label = cleanSpaces(description);
    let cashflow = amount(value);
    if (
      /purchase|switch[\s-]?in|sip|systematic investment|fresh allotment|additional allotment|reinvestment|dividend reinvestment|idcw reinvestment/i.test(label)
    ) {
      cashflow *= -1;
    } else if (/redemption|switch[\s-]?out|swp|dividend payout|idcw payout|payout|withdrawal/i.test(label)) {
      cashflow *= 1;
    } else {
      continue;
    }
    transactions.push({ date: toIsoDate(date), amount: cashflow, description: label });
  }
  return transactions.filter((transaction) => transaction.date && transaction.amount);
}

function parseSchemeBlock(text, header, end) {
  const prefix = text.slice(Math.max(0, header.index - 600), header.index);
  const block = text.slice(header.index, end);
  const valuation = block.match(
    new RegExp(String.raw`NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4}):\s*INR\s*(${money})\s+Market\s+Value\s+on\s+\d{2}-[A-Za-z]{3}-\d{4}:\s*INR\s*(${money})`, "i"),
  );
  const closing = block.match(new RegExp(String.raw`Closing\s+Unit\s+Balance:\s*(-?${money})\s+Total\s+Cost\s+Value:\s*(${money})`, "i"));
  if (!valuation && !closing) return null;

  const schemeName = cleanSchemeName(header[2]);
  const currentValue = valuation ? amount(valuation[3]) : 0;
  const costValue = closing ? amount(closing[2]) : 0;
  const units = closing ? amount(closing[1]) : 0;
  if (!currentValue && !units) return null;

  const folio = folioDetails(block);
  return {
    folio: folio.folio,
    amc: lastMutualFundName(prefix),
    schemeName,
    investor: {
      name: folio.name || extractInvestorName(prefix),
      pan: folio.pan || extractInvestorPan(prefix),
    },
    currentValue,
    costValue,
    units,
    nav: valuation ? amount(valuation[2]) : 0,
    transactions: parseTransactions(block),
  };
}

function groupedAccounts(holdings, fallbackInvestor, statementDate, warnings) {
  const groups = new Map();
  holdings.forEach((holding, index) => {
    const holdingInvestor = holding.investor || {};
    const hasHoldingIdentity = Boolean(holdingInvestor.name || holdingInvestor.pan);
    const investor = {
      name: holdingInvestor.name || (!hasHoldingIdentity ? fallbackInvestor.name : "") || "",
      pan: holdingInvestor.pan || (!hasHoldingIdentity ? fallbackInvestor.pan : "") || "",
      email: holdingInvestor.email || (!hasHoldingIdentity ? fallbackInvestor.email : "") || "",
      mobile: holdingInvestor.mobile || (!hasHoldingIdentity ? fallbackInvestor.mobile : "") || "",
    };
    const key = accountKey(investor, index);
    if (!groups.has(key)) groups.set(key, { investor, statementDate, holdings: [], warnings });
    groups.get(key).holdings.push(holding);
  });
  return [...groups.values()].filter((account) => account.holdings.length);
}

export class CamsAdapter extends GenericCasAdapter {
  constructor() {
    super();
    this.name = "CAMS";
  }

  matches(text) {
    return /computer age management services|\bCAMS(?:CASWS)?\b/i.test(text);
  }

  parse(text) {
    if (text.includes("AGM-CAS-JSON:")) return super.parse(text);

    const headers = [...text.matchAll(schemeHeader)];
    const holdings = headers
      .map((header, index) => parseSchemeBlock(text, header, headers[index + 1]?.index ?? text.length))
      .filter(Boolean);

    if (!holdings.length) {
      throw new Error("This CAMS statement layout could not be read safely. No report was created. Please upload a detailed CAMS CAS with valuation and transaction pages.");
    }

    const warnings = holdings.some((holding) => !holding.transactions.length)
      ? ["Some holdings did not include readable transaction rows, so CAGR/XIRR may be unavailable for those schemes."]
      : [];

    const summary = text.match(new RegExp(String.raw`Total\s+(${money})\s+(${money})\s+Date\s+Amount\s+Price\s+Units\s+Transaction`, "i"));
    if (summary) {
      const expectedCost = amount(summary[1]);
      const expectedValue = amount(summary[2]);
      const parsedCost = holdings.reduce((sum, holding) => sum + holding.costValue, 0);
      const parsedValue = holdings.reduce((sum, holding) => sum + holding.currentValue, 0);
      const costDiff = expectedCost ? Math.abs(parsedCost - expectedCost) / expectedCost : 0;
      const valueDiff = expectedValue ? Math.abs(parsedValue - expectedValue) / expectedValue : 0;
      if (costDiff > 0.02 || valueDiff > 0.02) {
        warnings.push("CAMS summary totals differ from the scheme-wise values read from the CAS. Please verify the totals before sharing the report.");
      }
    }

    const statementDate = toIsoDate(text.match(/\bTo\s+(\d{2}-[A-Za-z]{3}-\d{4})\b/i)?.[1]);

    const investor = {
      name: extractInvestorName(text) || holdings.find((holding) => holding.investor?.name)?.investor.name || "",
      pan: text.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/)?.[0] || "",
      email: text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || "",
      mobile: text.match(/(?:\+91[-\s]?)?[6-9]\d{9}/)?.[0] || "",
    };
    const accounts = groupedAccounts(holdings, investor, statementDate, warnings);

    return this.normalize({
      source: this.name,
      statementDate,
      investor,
      holdings,
      accounts: accounts.length > 1 ? accounts : [],
      warnings,
    });
  }
}
