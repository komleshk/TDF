import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { buildAnalytics, xirr } from "../src/analytics.js";
import { recommendationFor } from "../src/recommendations.js";
import { buildSwpProjection } from "../src/swp.js";
import { parseCasPdf, parseCasText } from "../src/cas/parser.js";
import { validateConfig } from "../src/config.js";

const fixture = {
  investor: {
    name: "Ananya Sharma",
    pan: "ABCDE1234F",
    email: "ananya@example.com",
    mobile: "9876543210"
  },
  statementDate: "2026-06-01",
  holdings: [
    {
      folio: "123456/78",
      amc: "HDFC Mutual Fund",
      schemeName: "HDFC ELSS Tax Saver Growth",
      category: "ELSS",
      currentValue: 185000,
      costValue: 150000,
      units: 2100,
      sip: { amount: 5000, frequency: "Monthly" },
      transactions: [
        { date: "2023-06-01", amount: -150000 },
        { date: "2026-06-01", amount: 185000 }
      ]
    },
    {
      folio: "998877/11",
      amc: "SBI Mutual Fund",
      schemeName: "SBI Small Cap Fund Growth",
      category: "Small Cap",
      currentValue: 21000,
      costValue: 18000,
      units: 100
    }
  ]
};

async function makeCasPdf(filePath, password) {
  await new Promise((resolve, reject) => {
    const options = password ? { userPassword: password, ownerPassword: "agm-owner-key" } : {};
    const doc = new PDFDocument(options);
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);
    doc.fontSize(14).text("CAMS Consolidated Account Statement");
    doc.fontSize(5).text(`AGM-CAS-JSON:${Buffer.from(JSON.stringify(fixture)).toString("base64url")} END-AGM-CAS`, { width: 500 });
    doc.end();
  });
}

test("password protected CAS is rejected without password and parsed with password", async () => {
  const file = path.join(os.tmpdir(), `agm-cas-${Date.now()}.pdf`);
  await makeCasPdf(file, "ABCDE1234F");
  await assert.rejects(() => parseCasPdf(file), /password protected/i);
  const parsed = await parseCasPdf(file, "ABCDE1234F");
  assert.equal(parsed.source, "CAMS");
  assert.equal(parsed.holdings.length, 2);
  assert.equal(parsed.holdings[0].isElss, true);
  fs.rmSync(file, { force: true });
});

test("detailed CAMS text is parsed by scheme blocks with validated totals", () => {
  const parsed = parseCasText(`
    CAMSCASWS- Version:V Live- Consolidated Account Statement-Jan- To-Jun
    Email: ananya@example.com Mobile: 9876543210 PAN: ABCDE1234F
    Period From 01-Jan-2026 To 30-Jun-2026
    HDFC Mutual Fund PAN: ABCDE1234F Folio No.: 123456/78
    PAN: OK INF179K01AB1 - HDFC ELSS Tax Saver Growth (Non-Demat) - ISIN: INF179K01AB1
    01-Jan-2024 150,000.00 71.4286 2100.000 Purchase
    Closing Unit Balance: 2100.000 Total Cost Value: 150,000.00
    NAV on 30-Jun-2026: INR 88.0952 Market Value on 30-Jun-2026: INR 185,000.00
    SBI Mutual Fund PAN: ABCDE1234F Folio No.: 998877/11
    PAN: OK INF200K01XY2 - SBI Small Cap Fund Growth (Non-Demat) - ISIN: INF200K01XY2
    15-Feb-2025 18,000.00 180.0000 100.000 Purchase
    Closing Unit Balance: 100.000 Total Cost Value: 18,000.00
    NAV on 30-Jun-2026: INR 210.0000 Market Value on 30-Jun-2026: INR 21,000.00
    Total 168,000.00 206,000.00 Date Amount Price Units Transaction
  `);
  assert.equal(parsed.source, "CAMS");
  assert.equal(parsed.statementDate, "2026-06-30");
  assert.equal(parsed.investor.pan, "ABCDE1234F");
  assert.equal(parsed.holdings.length, 2);
  assert.equal(parsed.holdings[0].amc, "HDFC Mutual Fund");
  assert.equal(parsed.holdings[0].schemeName, "HDFC ELSS Tax Saver Growth");
  assert.equal(parsed.holdings[0].currentValue, 185000);
  assert.equal(parsed.holdings[0].costValue, 150000);
  assert.equal(parsed.holdings[0].transactions[0].amount, -150000);
});

test("CAMS extraction rejects page-sized generic rows instead of creating a corrupt report", () => {
  assert.throws(
    () =>
      parseCasText(`
        CAMSCASWS- Version:V Live- Consolidated Account Statement-Jan- To-Jun HDFC Mutual Fund SBI Mutual Fund
        CAMSCASWS huge PDF page text CAMS Mutual Fund Growth Plan 1,612,405,939,695,488,300 3,812,851.28
      `),
    /could not be read safely/i,
  );
});

test("CAMS summary mismatch is warned but does not block valid scheme holdings", () => {
  const parsed = parseCasText(`
    CAMSCASWS- Version:V Live- Consolidated Account Statement-Jan- To-Jun
    HDFC Mutual Fund PAN: ABCDE1234F Folio No.: 123456/78
    PAN: OK INF179K01AB1 - HDFC ELSS Tax Saver Growth (Non-Demat) - ISIN: INF179K01AB1
    01-Jan-2024 150,000.00 71.4286 2100.000 Purchase
    Closing Unit Balance: 2100.000 Total Cost Value: 150,000.00
    NAV on 30-Jun-2026: INR 88.0952 Market Value on 30-Jun-2026: INR 185,000.00
    Total 168,000.00 206,000.00 Date Amount Price Units Transaction
  `);
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].currentValue, 185000);
  assert.match(parsed.warnings.join(" "), /summary totals differ/i);
});

test("analytics calculate totals, allocations and XIRR", () => {
  const holdings = fixture.holdings.map((item, index) => ({
    ...item,
    key: `h-${index}`,
    assetClass: "Equity",
    absoluteGain: item.currentValue - item.costValue,
    isElss: index === 0,
    transactions: item.transactions || []
  }));
  const analytics = buildAnalytics(holdings, {}, fixture.statementDate);
  assert.equal(analytics.totalValue, 206000);
  assert.equal(analytics.absoluteGain, 38000);
  assert.equal(analytics.smallHoldings.length, 1);
  assert.ok(analytics.xirr > 0);
  assert.equal(analytics.holdingReturns.length, 2);
  assert.ok(analytics.holdingReturns[0].xirr > 0);
  assert.ok(analytics.holdingReturns[0].cagr > 0);
  assert.equal(analytics.holdingReturns[1].xirr, null);
  assert.equal(analytics.holdingReturns[1].status, "missing-cashflows");
  assert.ok(xirr([{ date: "2020-01-01", amount: -100 }, { date: "2021-01-01", amount: 110 }]) > 9);
});

test("CAGR is withheld for multiple investments while XIRR remains available", () => {
  const analytics = buildAnalytics([{
    key: "sip",
    schemeName: "Example SIP Fund",
    category: "Equity",
    assetClass: "Equity",
    amc: "Example",
    currentValue: 130000,
    costValue: 120000,
    transactions: [
      { date: "2025-01-01", amount: -60000 },
      { date: "2025-07-01", amount: -60000 },
    ],
  }], {}, "2026-01-01");
  assert.ok(analytics.holdingReturns[0].xirr > 0);
  assert.equal(analytics.holdingReturns[0].cagr, null);
});

test("recommendation rules flag ELSS SIP and small holdings", () => {
  const elss = { ...fixture.holdings[0], key: "a", assetClass: "Equity", isElss: true };
  const small = { ...fixture.holdings[1], key: "b", assetClass: "Equity", isElss: false };
  assert.equal(recommendationFor(elss, [elss, small]).systemAction, "Stop SIP");
  assert.equal(recommendationFor(small, [elss, small]).systemAction, "Review");
});

test("SWP projection returns yearly corpus and withdrawal totals", () => {
  const result = buildSwpProjection({ principal: 5000000, monthlyWithdrawal: 50000, annualReturn: 10, years: 10 });
  assert.equal(result.rows.length, 10);
  assert.equal(result.rows[0].totalWithdrawn, 600000);
  assert.ok(result.rows.at(-1).endingCorpus > 0);
  assert.throws(
    () => buildSwpProjection({ principal: 5000000, monthlyWithdrawal: 50000, annualReturn: 10, years: 1000 }),
    /between 1 and 40 years/,
  );
});

test("production configuration rejects unsafe credentials and non-HTTPS origins", () => {
  const base = {
    port: 3000,
    sessionTtlHours: 12,
    maxUploadMb: 15,
    maxCasPages: 500,
    adminEmail: "admin@example.com",
    adminPassword: "A-safe-password-123",
    origin: "https://wealth.example.com",
    production: true,
  };
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig({ ...base, adminPassword: "ChangeMeNow!123" }), /non-default/);
  assert.throws(() => validateConfig({ ...base, origin: "http://wealth.example.com" }), /HTTPS/);
});
