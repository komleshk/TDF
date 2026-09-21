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
import { normalizeHolding } from "../src/cas/normalize.js";

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
    Investor Name: Ananya Sharma PAN: ABCDE1234F Email: ananya@example.com Mobile: 9876543210
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
  assert.equal(parsed.investor.name, "Ananya Sharma");
  assert.equal(parsed.investor.pan, "ABCDE1234F");
  assert.equal(parsed.holdings.length, 2);
  assert.equal(parsed.holdings[0].amc, "HDFC Mutual Fund");
  assert.equal(parsed.holdings[0].schemeName, "HDFC ELSS Tax Saver Growth");
  assert.equal(parsed.holdings[0].currentValue, 185000);
  assert.equal(parsed.holdings[0].costValue, 150000);
  assert.equal(parsed.holdings[0].transactions[0].amount, -150000);
});

test("CAMS parser reads client name from unit holder and salutation formats", () => {
  const baseHolding = `
    HDFC Mutual Fund PAN: ABCDE1234F Folio No.: 123456/78
    PAN: OK INF179K01AB1 - HDFC ELSS Tax Saver Growth (Non-Demat) - ISIN: INF179K01AB1
    Closing Unit Balance: 2100.000 Total Cost Value: 150,000.00
    NAV on 30-Jun-2026: INR 88.0952 Market Value on 30-Jun-2026: INR 185,000.00
  `;
  assert.equal(parseCasText(`CAMSCASWS Unit Holder Name : Poonam Mutreja PAN: ABCDE1234F ${baseHolding}`).investor.name, "Poonam Mutreja");
  assert.equal(parseCasText(`CAMSCASWS Dear Ms. Kavita Rao, ${baseHolding}`).investor.name, "Kavita Rao");
});

test("CAMS family text is split into separate investor accounts", () => {
  const parsed = parseCasText(`
    CAMSCASWS- Version:V Live- Consolidated Account Statement-Jan- To-Jun
    Investor Name: Raj Shah PAN: ABCDE1234F
    HDFC Mutual Fund PAN: ABCDE1234F Folio No.: 111111/11
    PAN: OK INF179K01AB1 - HDFC Flexi Cap Fund Growth (Non-Demat) - ISIN: INF179K01AB1
    01-Jan-2024 100,000.00 100.0000 1000.000 Purchase
    Closing Unit Balance: 1000.000 Total Cost Value: 100,000.00
    NAV on 30-Jun-2026: INR 125.0000 Market Value on 30-Jun-2026: INR 125,000.00
    Unit Holder Name: Meera Shah PAN: FGHIJ5678K
    SBI Mutual Fund PAN: FGHIJ5678K Folio No.: 222222/22
    PAN: OK INF200K01XY2 - SBI Bluechip Fund Growth (Non-Demat) - ISIN: INF200K01XY2
    01-Feb-2024 200,000.00 200.0000 1000.000 Purchase
    Closing Unit Balance: 1000.000 Total Cost Value: 200,000.00
    NAV on 30-Jun-2026: INR 240.0000 Market Value on 30-Jun-2026: INR 240,000.00
  `);
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.accounts[0].investor.name, "Raj Shah");
  assert.equal(parsed.accounts[0].investor.pan, "ABCDE1234F");
  assert.equal(parsed.accounts[1].investor.name, "Meera Shah");
  assert.equal(parsed.accounts[1].investor.pan, "FGHIJ5678K");
  assert.equal(parsed.accounts[1].holdings[0].currentValue, 240000);
});

test("CAMS spaced demat headers keep scheme name clean and read folio holder name", () => {
  const parsed = parseCasText(`
    CAMSCASWS-11092617138 Version:V3.5 Live-1018 Consolidated Account Statement
    Bandhan Mutual Fund PAN:
    PAN: OK INF194K01524 - Bandhan Large & Mid Cap Fund - Regular Plan - Growth ( Formerly Known as Bandhan Core Equity Fund-Regular Plan-Growth ) (Non - Demat) - ISIN: INF194K01524(Advisor: ARN-177245) Registrar : CAMS Folio No: 4009282 / 57 Ram Singh Ratkuria Nominee 1: Jaideep Singh Nominee 2: Nominee 3: Opening Unit Balance: 0.000
    17-Jul-2023 9,999.50 83.119 120.303 Systematic Purchase Physical - Instalment 1
    10-Aug-2023 9,999.50 85.155 117.427 Systematic Purchase - Instalment 2/918 Physical
    Closing Unit Balance: 237.730 Total Cost Value: 19,999.00
    NAV on 11-Sep-2026: INR 100.0000 Market Value on 11-Sep-2026: INR 23,773.00
  `);
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].schemeName, "Bandhan Large & Mid Cap Fund - Regular Plan - Growth ( Formerly Known as Bandhan Core Equity Fund-Regular Plan-Growth )");
  assert.equal(parsed.holdings[0].folio, "4009282/57");
  assert.equal(parsed.accounts[0]?.investor.name || parsed.investor.name, "Ram Singh Ratkuria");
  assert.equal(parsed.holdings[0].currentValue, 23773);
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

test("gold and silver funds are tagged as Gold/Silver", () => {
  const silver = normalizeHolding({ schemeName: "ICICI Prudential Silver ETF Fund of Fund Growth", currentValue: 10000 });
  const gold = normalizeHolding({ schemeName: "SBI Gold Fund Growth", currentValue: 10000 });
  assert.equal(silver.assetClass, "Gold/Silver");
  assert.equal(silver.category, "Gold/Silver");
  assert.equal(gold.assetClass, "Gold/Silver");
  assert.equal(gold.category, "Gold/Silver");
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
