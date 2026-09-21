import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { db, getSettings } from "./db.js";
import { loadEnv } from "./config.js";
import { buildAnalytics } from "./analytics.js";

const inr = (value) => `Rs. ${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
const pct = (value) => `${Number(value || 0).toFixed(1)}%`;
const returnPct = (value) => value == null ? "—" : `${Number(value).toFixed(2)}%`;
const reportConfig = loadEnv();

function loadReport(reportId) {
  const report = db()
    .prepare(
      `SELECT reports.*, clients.name client_name, clients.pan, clients.email, clients.mobile, clients.risk_profile
       FROM reports JOIN clients ON clients.id=reports.client_id WHERE reports.id=?`,
    )
    .get(reportId);
  if (!report) return null;
  report.portfolio = JSON.parse(report.portfolio_json);
  report.analytics = JSON.parse(report.analytics_json);
  if (!Array.isArray(report.analytics.holdingReturns)) {
    report.analytics = buildAnalytics(report.portfolio.holdings, getSettings(), report.statement_date || report.portfolio.statementDate);
  }
  report.recommendations = db().prepare("SELECT * FROM recommendations WHERE report_id=? ORDER BY id").all(reportId);
  report.notes = db().prepare("SELECT * FROM internal_notes WHERE report_id=?").get(reportId) || {};
  report.model = report.model_portfolio_id
    ? db().prepare("SELECT * FROM model_portfolios WHERE id=?").get(report.model_portfolio_id)
    : null;
  if (report.model) {
    report.model.items = JSON.parse(report.model.items_json);
    report.model.assumptions = JSON.parse(report.model.assumptions_json);
  }
  report.swp = report.swp_json ? JSON.parse(report.swp_json) : null;
  return report;
}

function normalizedPersonName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function familyMembersFromReports(reports) {
  const members = new Map();
  reports.forEach((report, index) => {
    const key = normalizedPersonName(report.client_name) || report.pan || `member-${index + 1}`;
    if (!members.has(key)) {
      members.set(key, {
        clientName: report.client_name,
        pan: report.pan || "",
        source: report.source,
        holdings: [],
        reports: [],
        analytics: { totalValue: 0, totalCost: 0, absoluteGain: 0, gainPercent: 0, xirr: null },
      });
    }
    const member = members.get(key);
    member.reports.push(report);
    member.holdings.push(...(report.portfolio.holdings || []));
    if (!member.pan && report.pan) member.pan = report.pan;
    member.analytics.totalValue += report.analytics.totalValue || 0;
    member.analytics.totalCost += report.analytics.totalCost || 0;
    member.analytics.absoluteGain += report.analytics.absoluteGain || 0;
  });
  return [...members.values()].map((member) => ({
    ...member,
    analytics: {
      ...member.analytics,
      gainPercent: member.analytics.totalCost ? (member.analytics.absoluteGain / member.analytics.totalCost) * 100 : 0,
    },
  }));
}

function pdfTableHeader(doc, y, columns) {
  doc.save().rect(48, y, 500, 24).fill("#15375b").fillColor("#fff").fontSize(8);
  columns.forEach((column) => doc.text(column.label, column.x, y + 8, { width: column.width }));
  doc.restore();
  return y + 28;
}

function ensurePage(doc, y, needed = 40) {
  if (y + needed < 760) return y;
  doc.addPage();
  return 48;
}

export function streamPdfReport(reportId, response, { includeInternal = false } = {}) {
  const report = loadReport(reportId);
  if (!report) throw new Error("Report not found");
  const settings = getSettings();
  const doc = new PDFDocument({ margin: 48, size: "A4", bufferPages: true, info: { Title: `${report.client_name} Portfolio Review`, Author: settings.companyName } });
  doc.pipe(response);

  doc.rect(0, 0, 595, 842).fill("#f8fafc");
  doc.rect(0, 0, 595, 16).fill("#c59742");
  const storedLogoPath = settings.logoUrl
    ? path.join(reportConfig.storagePath, "branding", path.basename(settings.logoUrl))
    : null;
  const bundledLogoPath = settings.logoUrl
    ? path.join(reportConfig.projectRoot || path.resolve("."), "public", "branding", path.basename(settings.logoUrl))
    : null;
  const logoPath =
    storedLogoPath && fs.existsSync(storedLogoPath)
      ? storedLogoPath
      : bundledLogoPath && fs.existsSync(bundledLogoPath)
        ? bundledLogoPath
        : null;
  if (logoPath && fs.existsSync(logoPath)) {
    doc.image(logoPath, 48, 70, { fit: [150, 70] });
  } else {
    doc.fillColor("#15375b").fontSize(30).font("Helvetica-Bold").text(settings.companyName, 48, 90);
  }
  doc.fontSize(13).font("Helvetica").fillColor("#64748b").text("Portfolio Review & Action Plan", 48, 135);
  doc.moveTo(48, 175).lineTo(547, 175).strokeColor("#d7dee8").stroke();
  doc.fillColor("#15375b").fontSize(20).font("Helvetica-Bold").text(report.client_name, 48, 218);
  doc.fillColor("#64748b").fontSize(10).font("Helvetica");
  if (report.pan) doc.text(`PAN: ${report.pan}`, 48, 253);
  doc.text(`Statement source: ${report.source}`, 48, 269);
  doc.text(`Prepared on: ${new Date().toLocaleDateString("en-IN")}`, 48, 285);
  doc.fillColor("#c59742").fontSize(11).font("Helvetica-Bold").text("CONFIDENTIAL CLIENT DOCUMENT", 48, 360);

  doc.addPage();
  doc.fillColor("#15375b").fontSize(20).font("Helvetica-Bold").text("Portfolio summary");
  doc.fontSize(11).font("Helvetica").fillColor("#334155");
  doc.text(`Current value: ${inr(report.analytics.totalValue)}`, 48, 90);
  doc.text(`Invested cost: ${inr(report.analytics.totalCost)}`, 48, 110);
  doc.text(`Absolute gain/loss: ${inr(report.analytics.absoluteGain)} (${pct(report.analytics.gainPercent)})`, 48, 130);
  doc.text(`Portfolio XIRR: ${returnPct(report.analytics.xirr)}`, 48, 150);
  doc.text(`Risk profile: ${report.risk_profile}`, 48, 170);
  let y = 195;
  doc.fillColor("#15375b").fontSize(14).font("Helvetica-Bold").text("Asset allocation", 48, y);
  y += 28;
  for (const item of report.analytics.byAssetClass) {
    doc.fillColor("#334155").fontSize(10).font("Helvetica").text(item.name, 48, y);
    doc.text(inr(item.value), 260, y, { width: 110, align: "right" });
    doc.text(pct(item.percent), 390, y, { width: 80, align: "right" });
    y += 20;
  }

  y += 20;
  y = ensurePage(doc, y, 100);
  doc.fillColor("#15375b").fontSize(14).font("Helvetica-Bold").text("Key observations", 48, y);
  y += 24;
  const observations = [
    report.analytics.duplicateCategories.length ? `${report.analytics.duplicateCategories.length} categories contain multiple schemes and merit overlap review.` : "No duplicate category exposure was detected.",
    report.analytics.smallHoldings.length ? `${report.analytics.smallHoldings.length} small-value holdings may be candidates for consolidation.` : "No small-value holdings were flagged.",
    report.analytics.elss.length ? `${report.analytics.elss.length} ELSS holdings require transaction-level lock-in checks.` : "No ELSS holdings were identified.",
    report.analytics.concentrated.length ? `${report.analytics.concentrated.length} holdings exceed the configured concentration threshold.` : "No scheme-level concentration exception was flagged.",
  ];
  for (const observation of observations) {
    doc.fillColor("#334155").fontSize(10).font("Helvetica").text(`• ${observation}`, 58, y, { width: 475 });
    y += 30;
  }

  doc.addPage();
  doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("Portfolio holdings and investor returns");
  doc.fillColor("#64748b").fontSize(8).font("Helvetica").text(
    "XIRR uses dated investor cash flows plus the statement-date market value. CAGR is shown only for a single-investment holding. A dash means transaction history was insufficient.",
    48,
    78,
    { width: 500 },
  );
  y = 112;
  const holdingColumns = [
    { label: "Scheme", x: 48, width: 142 },
    { label: "Category", x: 194, width: 72 },
    { label: "Alloc.", x: 270, width: 42 },
    { label: "Cost", x: 316, width: 62 },
    { label: "Value", x: 382, width: 62 },
    { label: "XIRR", x: 448, width: 45 },
    { label: "CAGR", x: 497, width: 48 },
  ];
  y = pdfTableHeader(doc, y, holdingColumns);
  const holdingReturns = Object.fromEntries((report.analytics.holdingReturns || []).map((item) => [item.key, item]));
  for (const holding of report.portfolio.holdings) {
    y = ensurePage(doc, y, 42);
    if (y === 48) y = pdfTableHeader(doc, y, holdingColumns);
    const itemReturn = holdingReturns[holding.key] || {};
    const allocation = report.analytics.totalValue ? (holding.currentValue / report.analytics.totalValue) * 100 : 0;
    const rowHeight = Math.max(34, doc.heightOfString(holding.schemeName, { width: 142 }) + 12);
    doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica");
    doc.text(holding.schemeName, 48, y + 6, { width: 142 });
    doc.text(holding.category, 194, y + 6, { width: 72 });
    doc.text(pct(allocation), 270, y + 6, { width: 42, align: "right" });
    doc.text(inr(holding.costValue), 316, y + 6, { width: 62, align: "right" });
    doc.text(inr(holding.currentValue), 382, y + 6, { width: 62, align: "right" });
    doc.text(returnPct(itemReturn.xirr), 448, y + 6, { width: 45, align: "right" });
    doc.text(returnPct(itemReturn.cagr), 497, y + 6, { width: 48, align: "right" });
    doc.moveTo(48, y + rowHeight).lineTo(548, y + rowHeight).strokeColor("#e2e8f0").stroke();
    y += rowHeight;
  }

  doc.addPage();
  doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("Fund-wise recommendations");
  y = 85;
  const columns = [
    { label: "Scheme", x: 48, width: 190 },
    { label: "Value", x: 244, width: 70 },
    { label: "Action", x: 320, width: 70 },
    { label: "Client note", x: 396, width: 150 },
  ];
  y = pdfTableHeader(doc, y, columns);
  const holdingsByKey = Object.fromEntries(report.portfolio.holdings.map((item) => [item.key, item]));
  for (const recommendation of report.recommendations) {
    y = ensurePage(doc, y, 58);
    if (y === 48) y = pdfTableHeader(doc, y, columns);
    const holding = holdingsByKey[recommendation.holding_key] || {};
    const rowHeight = Math.max(48, doc.heightOfString(recommendation.client_note || recommendation.system_reason, { width: 150 }) + 14);
    doc.fillColor("#1e293b").fontSize(8).font("Helvetica");
    doc.text(holding.schemeName || recommendation.holding_key, 48, y + 7, { width: 190 });
    doc.text(inr(holding.currentValue), 244, y + 7, { width: 70 });
    doc.font("Helvetica-Bold").text(recommendation.final_action, 320, y + 7, { width: 70 });
    doc.font("Helvetica").text(recommendation.client_note || recommendation.system_reason, 396, y + 7, { width: 150 });
    doc.moveTo(48, y + rowHeight).lineTo(548, y + rowHeight).strokeColor("#e2e8f0").stroke();
    y += rowHeight;
  }

  if (report.model) {
    doc.addPage();
    doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("Proposed portfolio allocation");
    doc.fillColor("#475569").fontSize(10).font("Helvetica").text(`${report.model.name} · ${report.model.risk_level}`, 48, 78);
    y = 110;
    y = pdfTableHeader(doc, y, [
      { label: "Asset / category", x: 48, width: 170 },
      { label: "Suggested fund", x: 224, width: 190 },
      { label: "Allocation", x: 420, width: 70 },
    ]);
    for (const item of report.model.items) {
      doc.fillColor("#334155").fontSize(9).font("Helvetica").text(item.category || "", 48, y, { width: 170 });
      doc.text(item.fund || "Category allocation", 224, y, { width: 190 });
      doc.text(pct(item.allocation), 420, y, { width: 70 });
      y += 25;
    }
    if (report.model.assumptions?.riskNote) doc.text(`Risk note: ${report.model.assumptions.riskNote}`, 48, y + 20, { width: 500 });
  }

  if (report.swp?.rows?.length) {
    doc.addPage();
    doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("SWP projection");
    doc.fillColor("#475569").fontSize(10).font("Helvetica").text(
      `Initial corpus ${inr(report.swp.assumptions.principal)} · Monthly SWP ${inr(report.swp.assumptions.monthlyWithdrawal)} · Assumed return ${pct(report.swp.assumptions.annualReturn)}`,
      48,
      80,
    );
    y = 115;
    y = pdfTableHeader(doc, y, [
      { label: "Year", x: 48, width: 70 },
      { label: "Total withdrawn", x: 150, width: 150 },
      { label: "Ending corpus", x: 340, width: 150 },
    ]);
    for (const row of report.swp.rows) {
      doc.fillColor("#334155").fontSize(9).font("Helvetica").text(String(row.year), 48, y);
      doc.text(inr(row.totalWithdrawn), 150, y);
      doc.text(inr(row.endingCorpus), 340, y);
      y += 23;
    }
  }

  if (includeInternal) {
    doc.addPage();
    doc.fillColor("#9f1239").fontSize(18).font("Helvetica-Bold").text("Internal notes — not for client circulation");
    doc.fillColor("#334155").fontSize(10).font("Helvetica").text(JSON.stringify(report.notes, null, 2), 48, 88);
  }

  doc.addPage();
  doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("Important disclaimer");
  doc.fillColor("#475569").fontSize(10).font("Helvetica").text(settings.disclaimer, 48, 90, { width: 500, lineGap: 5 });
  doc.fontSize(9).fillColor("#64748b").text(settings.reportFooter, 48, 730, { align: "center", width: 500 });
  doc.end();
}

export function streamFamilyPdfReport(familyBatchId, response) {
  const rows = db()
    .prepare("SELECT id FROM reports WHERE family_batch_id=? ORDER BY id")
    .all(familyBatchId);
  const reports = rows.map((row) => loadReport(row.id)).filter(Boolean);
  if (!reports.length) throw new Error("Family report batch not found");
  const members = familyMembersFromReports(reports);
  const settings = getSettings();
  const doc = new PDFDocument({ margin: 48, size: "A4", info: { Title: "Family Portfolio Review", Author: settings.companyName } });
  doc.pipe(response);

  const familyValue = members.reduce((sum, member) => sum + member.analytics.totalValue, 0);
  const familyCost = members.reduce((sum, member) => sum + member.analytics.totalCost, 0);
  doc.rect(0, 0, 595, 842).fill("#f8fafc");
  doc.rect(0, 0, 595, 16).fill("#c59742");
  doc.fillColor("#15375b").fontSize(30).font("Helvetica-Bold").text(settings.companyName, 48, 90);
  doc.fontSize(13).font("Helvetica").fillColor("#64748b").text("Family Portfolio Review", 48, 135);
  doc.moveTo(48, 175).lineTo(547, 175).strokeColor("#d7dee8").stroke();
  doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text(`${members.length} family members`, 48, 220);
  doc.fillColor("#334155").fontSize(11).font("Helvetica");
  doc.text(`Combined current value: ${inr(familyValue)}`, 48, 255);
  doc.text(`Combined invested cost: ${inr(familyCost)}`, 48, 275);
  doc.text(`Combined gain/loss: ${inr(familyValue - familyCost)} (${pct(familyCost ? ((familyValue - familyCost) / familyCost) * 100 : 0)})`, 48, 295);
  doc.text(`Prepared on: ${new Date().toLocaleDateString("en-IN")}`, 48, 315);

  let y = 365;
  y = pdfTableHeader(doc, y, [
    { label: "Family member", x: 48, width: 190 },
    { label: "PAN", x: 242, width: 95 },
    { label: "Cost", x: 342, width: 80 },
    { label: "Value", x: 426, width: 80 },
    { label: "Gain", x: 510, width: 38 },
  ]);
  for (const member of members) {
    doc.fillColor("#1e293b").fontSize(8.5).font("Helvetica");
    doc.text(member.clientName, 48, y + 6, { width: 190 });
    doc.text(member.pan || "—", 242, y + 6, { width: 95 });
    doc.text(inr(member.analytics.totalCost), 342, y + 6, { width: 80, align: "right" });
    doc.text(inr(member.analytics.totalValue), 426, y + 6, { width: 80, align: "right" });
    doc.text(pct(member.analytics.gainPercent), 510, y + 6, { width: 38, align: "right" });
    doc.moveTo(48, y + 25).lineTo(548, y + 25).strokeColor("#e2e8f0").stroke();
    y += 25;
  }

  for (const member of members) {
    doc.addPage();
    doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text(member.clientName);
    doc.fillColor("#64748b").fontSize(9).font("Helvetica").text(`${member.source} CAS${member.pan ? ` · PAN ${member.pan}` : ""}`, 48, 74);
    doc.fillColor("#334155").fontSize(10);
    doc.text(`Current value: ${inr(member.analytics.totalValue)}`, 48, 105);
    doc.text(`Invested cost: ${inr(member.analytics.totalCost)}`, 48, 123);
    doc.text(`Gain/loss: ${inr(member.analytics.absoluteGain)} (${pct(member.analytics.gainPercent)})`, 48, 141);
    doc.text(`Portfolio XIRR: ${returnPct(member.analytics.xirr)}`, 48, 159);

    y = 195;
    y = pdfTableHeader(doc, y, [
      { label: "Scheme", x: 48, width: 180 },
      { label: "Folio", x: 232, width: 70 },
      { label: "Cost", x: 306, width: 70 },
      { label: "Value", x: 380, width: 70 },
      { label: "Gain", x: 454, width: 70 },
    ]);
    for (const holding of member.holdings) {
      const rowHeight = Math.max(30, doc.heightOfString(holding.schemeName, { width: 180 }) + 12);
      y = ensurePage(doc, y, rowHeight + 8);
      if (y === 48) {
        doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text(`${member.clientName} holdings`);
        y = pdfTableHeader(doc, 82, [
          { label: "Scheme", x: 48, width: 180 },
          { label: "Folio", x: 232, width: 70 },
          { label: "Cost", x: 306, width: 70 },
          { label: "Value", x: 380, width: 70 },
          { label: "Gain", x: 454, width: 70 },
        ]);
      }
      doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica");
      doc.text(holding.schemeName, 48, y + 6, { width: 180 });
      doc.text(holding.folio || "—", 232, y + 6, { width: 70 });
      doc.text(inr(holding.costValue), 306, y + 6, { width: 70, align: "right" });
      doc.text(inr(holding.currentValue), 380, y + 6, { width: 70, align: "right" });
      doc.text(inr(holding.absoluteGain), 454, y + 6, { width: 70, align: "right" });
      doc.moveTo(48, y + rowHeight).lineTo(548, y + rowHeight).strokeColor("#e2e8f0").stroke();
      y += rowHeight;
    }
  }

  doc.addPage();
  doc.fillColor("#15375b").fontSize(18).font("Helvetica-Bold").text("Important disclaimer");
  doc.fillColor("#475569").fontSize(10).font("Helvetica").text(settings.disclaimer, 48, 90, { width: 500, lineGap: 5 });
  doc.fontSize(9).fillColor("#64748b").text(settings.reportFooter, 48, 730, { align: "center", width: 500 });
  doc.end();
}

function styleSheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF15375B" } };
  sheet.columns.forEach((column) => {
    column.width = Math.min(48, Math.max(14, ...column.values.slice(1).map((value) => String(value ?? "").length + 2)));
  });
}

export async function writeExcelReport(reportId, response) {
  const report = loadReport(reportId);
  if (!report) throw new Error("Report not found");
  const settings = getSettings();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = settings.companyName;

  const summary = workbook.addWorksheet("Portfolio Summary");
  summary.addRows([
    ["Metric", "Value"],
    ["Client", report.client_name],
    ["PAN", report.pan || ""],
    ["Current value", report.analytics.totalValue],
    ["Cost value", report.analytics.totalCost],
    ["Absolute gain/loss", report.analytics.absoluteGain],
    ["Gain/loss %", report.analytics.gainPercent / 100],
    ["Portfolio XIRR", report.analytics.xirr == null ? "Unavailable — dated cash flows required" : report.analytics.xirr / 100],
  ]);
  ["B4", "B5", "B6"].forEach((cell) => { summary.getCell(cell).numFmt = "₹#,##0.00"; });
  ["B7", "B8"].forEach((cell) => { summary.getCell(cell).numFmt = "0.00%"; });
  styleSheet(summary);

  const holdings = workbook.addWorksheet("Fund-wise Holding");
  holdings.addRow(["Folio", "AMC", "Scheme", "Asset Class", "Category", "Option", "Units", "NAV", "Cost", "Current Value", "Gain/Loss", "Allocation %", "XIRR", "CAGR", "Return Since", "Cash-flow Status"]);
  const holdingReturnMap = Object.fromEntries((report.analytics.holdingReturns || []).map((item) => [item.key, item]));
  report.portfolio.holdings.forEach((item) => {
    const itemReturn = holdingReturnMap[item.key] || {};
    holdings.addRow([
      item.folio,
      item.amc,
      item.schemeName,
      item.assetClass,
      item.category,
      item.option,
      item.units,
      item.nav,
      item.costValue,
      item.currentValue,
      item.absoluteGain,
      report.analytics.totalValue ? item.currentValue / report.analytics.totalValue : 0,
      itemReturn.xirr == null ? "Unavailable" : itemReturn.xirr / 100,
      itemReturn.cagr == null ? "Not applicable" : itemReturn.cagr / 100,
      itemReturn.firstInvestmentDate || "",
      itemReturn.status === "calculated" ? "Calculated from dated transactions" : "Dated transactions missing",
    ]);
  });
  ["L", "M", "N"].forEach((column) => { holdings.getColumn(column).numFmt = "0.00%"; });
  styleSheet(holdings);

  const recommendations = workbook.addWorksheet("Recommendation");
  recommendations.addRow(["Scheme", "System Suggestion", "System Reason", "Final Action", "Client Note", "Internal Note"]);
  const byKey = Object.fromEntries(report.portfolio.holdings.map((item) => [item.key, item]));
  report.recommendations.forEach((item) => recommendations.addRow([byKey[item.holding_key]?.schemeName, item.system_action, item.system_reason, item.final_action, item.client_note, item.internal_note]));
  styleSheet(recommendations);

  const allocation = workbook.addWorksheet("Proposed Allocation");
  allocation.addRow(["Model", "Risk Level", "Asset / Category", "Suggested Fund", "Allocation %", "Amount"]);
  if (report.model) {
    report.model.items.forEach((item) => allocation.addRow([report.model.name, report.model.risk_level, item.category, item.fund, item.allocation / 100, item.amount]));
  } else {
    allocation.addRow(["Not attached", "", "", "", "", ""]);
  }
  styleSheet(allocation);

  const swp = workbook.addWorksheet("SWP Projection");
  swp.addRow(["Year", "Total Withdrawn", "Ending Corpus"]);
  if (report.swp?.rows?.length) report.swp.rows.forEach((row) => swp.addRow([row.year, row.totalWithdrawn, row.endingCorpus]));
  else swp.addRow(["Not attached", "", ""]);
  styleSheet(swp);

  const notes = workbook.addWorksheet("Internal Notes");
  notes.addRow(["Field", "Value"]);
  Object.entries(report.notes).forEach(([key, value]) => notes.addRow([key, value]));
  styleSheet(notes);

  const disclaimer = workbook.addWorksheet("Disclaimer");
  disclaimer.addRow(["AGM Wealth Disclaimer"]);
  disclaimer.addRow([settings.disclaimer]);
  disclaimer.getColumn(1).width = 110;
  disclaimer.getRow(2).alignment = { wrapText: true, vertical: "top" };
  styleSheet(disclaimer);

  response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await workbook.xlsx.write(response);
  response.end();
}
