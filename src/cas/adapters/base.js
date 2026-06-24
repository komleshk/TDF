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
    return {
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
  }
}
