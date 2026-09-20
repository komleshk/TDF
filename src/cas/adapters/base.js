import { normalizeHolding } from "../normalize.js";

export class CasAdapter {
  constructor(name) {
    this.name = name;
  }

  matches() {
    return false;
  }

  parse() {
    throw new Error("Adapter parse() must be implemented");
  }

  normalize(result) {
    const normalized = {
      source: this.name,
      investor: {
        name: result.investor?.name || "",
        pan: result.investor?.pan || "",
        email: result.investor?.email || "",
        mobile: result.investor?.mobile || "",
      },
      statementDate: result.statementDate || null,
      holdings: (result.holdings || []).map(normalizeHolding),
      warnings: result.warnings || [],
    };
    if (Array.isArray(result.accounts)) {
      normalized.accounts = result.accounts
        .map((account) => ({
          source: this.name,
          investor: {
            name: account.investor?.name || "",
            pan: account.investor?.pan || "",
            email: account.investor?.email || "",
            mobile: account.investor?.mobile || "",
          },
          statementDate: account.statementDate || result.statementDate || null,
          holdings: (account.holdings || []).map(normalizeHolding),
          warnings: [...(result.warnings || []), ...(account.warnings || [])],
        }))
        .filter((account) => account.holdings.length);
    }
    return normalized;
  }
}
