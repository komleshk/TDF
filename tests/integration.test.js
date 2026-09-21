import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";

const dbPath = path.join(os.tmpdir(), `agm-integration-${Date.now()}.sqlite`);
const storagePath = path.join(os.tmpdir(), `agm-integration-storage-${Date.now()}`);
const uploadPath = path.join(os.tmpdir(), `agm-integration-upload-${Date.now()}`);
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = dbPath;
process.env.STORAGE_PATH = storagePath;
process.env.UPLOAD_TMP_PATH = uploadPath;
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "StrongPassword!123";
process.env.APP_ORIGIN = "http://127.0.0.1";

const { app } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = "";
let csrf = "";

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && !["GET", "HEAD"].includes(options.method || "GET")) headers["x-csrf-token"] = csrf;
  if (options.body && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${url}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response;
}

function createPdf(overrides = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const payload = {
      investor: { name: "Test Client", pan: "ABCDE1234F" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "10001",
        amc: "HDFC Mutual Fund",
        schemeName: "HDFC Flexi Cap Fund Growth",
        category: "Flexi Cap",
        currentValue: 125000,
        costValue: 100000,
        units: 1000,
        transactions: [{ date: "2023-06-01", amount: -100000 }]
      }]
    };
    const finalPayload = {
      ...payload,
      ...overrides,
      investor: { ...payload.investor, ...(overrides.investor || {}) },
      holdings: overrides.holdings || payload.holdings,
    };
    const doc = new PDFDocument({ userPassword: "secret123", ownerPassword: "owner-secret" });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(12).text("CAMS Consolidated Account Statement");
    doc.fontSize(5).text(`AGM-CAS-JSON:${Buffer.from(JSON.stringify(finalPayload)).toString("base64url")} END-AGM-CAS`, { width: 500 });
    doc.end();
  });
}

test("authentication, client creation, protected upload and exports work end-to-end", async () => {
  let response = await request("/healthz");
  assert.equal(response.status, 200);
  response = await request("/readyz");
  assert.equal(response.status, 200);

  response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@test.local", password: "wrong" })
  });
  assert.equal(response.status, 401);

  response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@test.local", password: "StrongPassword!123" })
  });
  assert.equal(response.status, 200);
  csrf = (await response.json()).csrfToken;
  assert.ok(cookie.includes("agm_session="));

  response = await request("/api/clients", {
    method: "POST",
    body: JSON.stringify({ name: "Test Client", pan: "ABCDE1234F", mobile: "9876543210", riskProfile: "Moderate" })
  });
  assert.equal(response.status, 201);
  const client = await response.json();

  const form = new FormData();
  form.set("clientId", String(client.id));
  form.set("password", "secret123");
  form.set("cas", new Blob([await createPdf()], { type: "application/pdf" }), "protected-cas.pdf");
  response = await request("/api/cas/upload", { method: "POST", body: form });
  const uploadPayload = await response.json();
  assert.equal(response.status, 201, uploadPayload.error);
  const { reportId } = uploadPayload;

  response = await request(`/api/reports/${reportId}`);
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(review.report.portfolio.holdings.length, 1);
  assert.ok(review.report.analytics.xirr > 0);
  assert.ok(review.report.analytics.holdingReturns[0].cagr > 0);
  assert.equal(review.recommendations.length, 1);

  response = await request(`/api/reports/${reportId}/recommendations`, {
    method: "PUT",
    body: JSON.stringify({
      recommendations: [{
        holdingKey: review.recommendations[0].holding_key,
        finalAction: "Hold",
        clientNote: "Continue after confirming suitability.",
        internalNote: "Discuss at next review."
      }]
    })
  });
  assert.equal(response.status, 200);

  response = await request(`/api/reports/${reportId}/internal-notes`, {
    method: "PUT",
    body: JSON.stringify({
      taxCheck: true,
      exitLoadCheck: true,
      lockInCheck: false,
      discussionPoints: "Confirm goal horizon.",
      executionStatus: "Pending"
    })
  });
  assert.equal(response.status, 200);

  response = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({
      name: "Moderate Test Model",
      riskLevel: "Moderate",
      items: [
        { category: "Equity", fund: "Test Equity Fund", allocation: 60, amount: 600000 },
        { category: "Debt", fund: "Test Debt Fund", allocation: 40, amount: 400000 }
      ],
      assumptions: { expectedReturn: 10, timeHorizon: "7 years" }
    })
  });
  assert.equal(response.status, 201);
  const modelId = (await response.json()).id;

  response = await request(`/api/reports/${reportId}/plan`, {
    method: "PUT",
    body: JSON.stringify({
      modelId,
      swp: { principal: 5000000, monthlyWithdrawal: 50000, annualReturn: 10, years: 10 }
    })
  });
  assert.equal(response.status, 200);

  const logo = new FormData();
  logo.set("logo", new Blob([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  ], { type: "image/png" }), "logo.png");
  response = await request("/api/settings/logo", { method: "POST", body: logo });
  assert.equal(response.status, 200);

  response = await request("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Analyst",
      email: "analyst@test.local",
      password: "AnalystPassword!123",
      role: "staff"
    })
  });
  assert.equal(response.status, 201);

  response = await request(`/api/reports/${reportId}/pdf`);
  assert.equal(response.status, 200);
  const pdf = Buffer.from(await response.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");

  response = await request(`/api/reports/${reportId}/excel`);
  assert.equal(response.status, 200);
  const excel = Buffer.from(await response.arrayBuffer());
  assert.equal(excel.subarray(0, 2).toString(), "PK");

  response = await request("/api/does-not-exist");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("CAS upload can create a new client instead of requiring an existing selection", async () => {
  const form = new FormData();
  form.set("clientId", "__new__");
  form.set("newClientName", "New CAS Client");
  form.set("newClientPan", "FGHIJ5678K");
  form.set("newClientRiskProfile", "Aggressive");
  form.set("password", "secret123");
  form.set("cas", new Blob([await createPdf()], { type: "application/pdf" }), "new-client-cas.pdf");

  let response = await request("/api/cas/upload", { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  assert.ok(payload.clientId);

  const clientResponse = await request(`/api/clients/${payload.clientId}`);
  const clientPayload = await clientResponse.json();
  assert.equal(clientPayload.client.name, "New CAS Client");
  assert.equal(clientPayload.client.pan, "FGHIJ5678K");
});

test("family CAS upload creates separate client reports", async () => {
  const accounts = [
    {
      investor: { name: "Family One", pan: "PQRST1234U" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "20001",
        amc: "HDFC Mutual Fund",
        schemeName: "HDFC Balanced Advantage Fund Growth",
        currentValue: 150000,
        costValue: 120000,
        units: 1000,
        transactions: [{ date: "2024-01-01", amount: -120000 }],
      }],
    },
    {
      investor: { name: "Family One", pan: "PQRST1234U" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "20002",
        amc: "ICICI Prudential Mutual Fund",
        schemeName: "ICICI Prudential Silver ETF Fund of Fund Growth",
        currentValue: 50000,
        costValue: 40000,
        units: 500,
        transactions: [{ date: "2024-03-01", amount: -40000 }],
      }],
    },
    {
      investor: { name: "Family Two", pan: "VWXYZ5678A" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "30001",
        amc: "SBI Mutual Fund",
        schemeName: "SBI Large & Midcap Fund Growth",
        currentValue: 250000,
        costValue: 200000,
        units: 2000,
        transactions: [{ date: "2024-02-01", amount: -200000 }],
      }],
    },
  ];
  const familyPdf = await createPdf({ accounts, holdings: accounts.flatMap((account) => account.holdings), investor: { name: "Family", pan: "ABCDE1234F" } });
  const form = new FormData();
  form.set("familyMode", "1");
  form.set("newClientName", "Family");
  form.set("newClientRiskProfile", "Moderate");
  form.set("password", "secret123");
  form.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "family-cas.pdf");

  let response = await request("/api/cas/upload", { method: "POST", body: form });
  let payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.familyReviewRequired, true);
  assert.equal(payload.familyMembers.length, 2);
  assert.equal(payload.familyMembers[0].name, "Family One");
  assert.equal(payload.familyMembers[1].pan, "VWXYZ5678A");

  const confirmForm = new FormData();
  confirmForm.set("familyMode", "1");
  confirmForm.set("familyReviewed", "1");
  confirmForm.set("familyMemberOverrides", JSON.stringify(payload.familyMembers.map((member) => ({ selector: member.selector, name: member.name, pan: member.pan }))));
  confirmForm.set("newClientRiskProfile", "Moderate");
  confirmForm.set("password", "secret123");
  confirmForm.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "family-cas.pdf");

  response = await request("/api/cas/upload", { method: "POST", body: confirmForm });
  payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  assert.equal(payload.familyReports.length, 2);
  assert.ok(payload.familyBatchId);
  assert.equal(payload.familyPdfUrl, `/api/family-reports/${payload.familyBatchId}/pdf`);
  assert.equal(payload.familyReports[0].clientName, "Family One");
  assert.equal(payload.familyReports[1].pan, "VWXYZ5678A");

  const firstReport = await (await request(`/api/reports/${payload.familyReports[0].reportId}`)).json();
  const secondReport = await (await request(`/api/reports/${payload.familyReports[1].reportId}`)).json();
  assert.equal(firstReport.report.client_name, "Family One");
  assert.equal(firstReport.report.family_batch_id, payload.familyBatchId);
  assert.equal(firstReport.report.portfolio.holdings.length, 2);
  assert.equal(firstReport.report.analytics.totalValue, 200000);
  assert.equal(secondReport.report.client_name, "Family Two");
  assert.equal(secondReport.report.portfolio.holdings[0].currentValue, 250000);

  response = await request(payload.familyPdfUrl);
  assert.equal(response.status, 200);
  const pdf = Buffer.from(await response.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
});

test("family CAS keeps same detected name separate when PANs differ", async () => {
  const accounts = [
    {
      investor: { name: "Same Detected Name", pan: "AAAAA1111A" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "41001",
        amc: "HDFC Mutual Fund",
        schemeName: "HDFC Flexi Cap Fund Growth",
        currentValue: 100000,
        costValue: 90000,
        units: 1000,
        transactions: [{ date: "2024-01-01", amount: -90000 }],
      }],
    },
    {
      investor: { name: "Same Detected Name", pan: "BBBBB2222B" },
      statementDate: "2026-06-01",
      holdings: [{
        folio: "42001",
        amc: "SBI Mutual Fund",
        schemeName: "SBI Bluechip Fund Growth",
        currentValue: 50000,
        costValue: 45000,
        units: 500,
        transactions: [{ date: "2024-02-01", amount: -45000 }],
      }],
    },
  ];
  const form = new FormData();
  form.set("familyMode", "1");
  form.set("newClientRiskProfile", "Moderate");
  form.set("password", "secret123");
  form.set("cas", new Blob([await createPdf({ accounts, holdings: accounts.flatMap((account) => account.holdings), investor: { name: "Family", pan: "" } })], { type: "application/pdf" }), "same-name-family-cas.pdf");

  const response = await request("/api/cas/upload", { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.familyReviewRequired, true);
  assert.equal(payload.familyMembers.length, 2);
  assert.deepEqual(payload.familyMembers.map((member) => member.pan), ["AAAAA1111A", "BBBBB2222B"]);
});

test("family CAS review supports seven family members", async () => {
  const pans = ["AAAAA1111A", "BBBBB2222B", "CCCCC3333C", "DDDDD4444D", "EEEEE5555E", "FFFFF6666F", "GGGGG7777G"];
  const accounts = pans.map((pan, index) => ({
    investor: { name: `M${index + 1}`, pan },
    holdings: [{
      folio: `7${index + 1}`,
      schemeName: `Fund ${index + 1}`,
      currentValue: 100000 + index,
      costValue: 90000,
    }],
  }));
  const familyPdf = await createPdf({ accounts, holdings: accounts.flatMap((account) => account.holdings), investor: { name: "Family", pan: "" } });
  const form = new FormData();
  form.set("familyMode", "1");
  form.set("newClientRiskProfile", "Moderate");
  form.set("password", "secret123");
  form.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "seven-family-cas.pdf");

  let response = await request("/api/cas/upload", { method: "POST", body: form });
  let payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.familyReviewRequired, true);
  assert.equal(payload.familyMembers.length, 7);

  const confirmForm = new FormData();
  confirmForm.set("familyMode", "1");
  confirmForm.set("familyReviewed", "1");
  confirmForm.set("familyMemberOverrides", JSON.stringify(payload.familyMembers.map((member) => ({ selector: member.selector, name: member.name, pan: member.pan }))));
  confirmForm.set("newClientRiskProfile", "Moderate");
  confirmForm.set("password", "secret123");
  for (const member of payload.familyMembers) {
    confirmForm.append("reviewName", member.name);
    confirmForm.append("reviewPan", member.pan);
  }
  confirmForm.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "seven-family-cas.pdf");

  response = await request("/api/cas/upload", { method: "POST", body: confirmForm });
  payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  assert.equal(payload.familyReports.length, 7);
});

test("family CAS asks for mapping only after parsing unidentified holdings", async () => {
  const holdings = [
    {
      folio: "777777/01",
      amc: "HDFC Mutual Fund",
      schemeName: "HDFC Flexi Cap Fund Growth",
      currentValue: 100000,
      costValue: 90000,
      units: 1000,
      transactions: [{ date: "2024-01-01", amount: -90000 }],
    },
    {
      folio: "888888/02",
      amc: "SBI Mutual Fund",
      schemeName: "SBI Gold Fund Growth",
      currentValue: 50000,
      costValue: 45000,
      units: 500,
      transactions: [{ date: "2024-02-01", amount: -45000 }],
    },
  ];
  const form = new FormData();
  form.set("familyMode", "1");
  form.set("newClientRiskProfile", "Moderate");
  form.set("password", "secret123");
  form.set("cas", new Blob([await createPdf({ investor: { name: "", pan: "" }, holdings })], { type: "application/pdf" }), "unmapped-family-cas.pdf");

  const response = await request("/api/cas/upload", { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 422);
  assert.equal(payload.mappingRequired, true);
  assert.equal(payload.error, "Some folios/schemes could not be mapped. Add manual mapping lines below and submit again.");
  assert.ok(payload.unmapped.some((item) => item.includes("777777/01")));
  assert.ok(payload.unmapped.some((item) => item.includes("SBI Gold Fund Growth")));
});

test("family CAS manual mappings assign unmapped holdings without invented names", async () => {
  const holdings = [
    {
      folio: "777777/01",
      amc: "HDFC Mutual Fund",
      schemeName: "HDFC Flexi Cap Fund Growth",
      currentValue: 100000,
      costValue: 90000,
      units: 1000,
      transactions: [{ date: "2024-01-01", amount: -90000 }],
    },
    {
      folio: "888888/02",
      amc: "SBI Mutual Fund",
      schemeName: "SBI Gold Fund Growth",
      currentValue: 50000,
      costValue: 45000,
      units: 500,
      transactions: [{ date: "2024-02-01", amount: -45000 }],
    },
  ];
  const familyPdf = await createPdf({ investor: { name: "", pan: "" }, holdings });
  const form = new FormData();
  form.set("familyMode", "1");
  form.set("newClientRiskProfile", "Moderate");
  form.set("familyMappings", "777777/01 = Manual One | MANUL1234A\nSBI Gold Fund = Manual Two | MANUL5678B");
  form.set("password", "secret123");
  form.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "manual-family-cas.pdf");

  let response = await request("/api/cas/upload", { method: "POST", body: form });
  let payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.familyReviewRequired, true);
  assert.equal(payload.familyMembers.length, 2);

  const confirmForm = new FormData();
  confirmForm.set("familyMode", "1");
  confirmForm.set("familyReviewed", "1");
  confirmForm.set("familyMappings", "777777/01 = Manual One | MANUL1234A\nSBI Gold Fund = Manual Two | MANUL5678B");
  confirmForm.set("familyMemberOverrides", JSON.stringify(payload.familyMembers.map((member) => ({ selector: member.selector, name: member.name, pan: member.pan }))));
  confirmForm.set("newClientRiskProfile", "Moderate");
  confirmForm.set("password", "secret123");
  confirmForm.set("cas", new Blob([familyPdf], { type: "application/pdf" }), "manual-family-cas.pdf");

  response = await request("/api/cas/upload", { method: "POST", body: confirmForm });
  payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  assert.equal(payload.familyReports.length, 2);
  assert.equal(payload.familyReports[0].clientName, "Manual One");
  assert.equal(payload.familyReports[1].clientName, "Manual Two");
});

test("new client CAS upload gives clear instruction when client name is missing", async () => {
  const form = new FormData();
  form.set("clientId", "__new__");
  form.set("newClientRiskProfile", "Moderate");
  form.set("password", "secret123");
  form.set("cas", new Blob([await createPdf({ investor: { name: "", pan: "KLMNO1234P" } })], { type: "application/pdf" }), "missing-name-cas.pdf");

  const response = await request("/api/cas/upload", { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.match(payload.error, /New client name field/i);
});

test("expired sessions are rejected using real timestamp comparison", async () => {
  db().prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const response = await request("/api/auth/me");
  assert.equal(response.status, 401);
});

test.after(() => {
  server.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(storagePath, { recursive: true, force: true });
  fs.rmSync(uploadPath, { recursive: true, force: true });
});
