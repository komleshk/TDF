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

function createPdf() {
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
    const doc = new PDFDocument({ userPassword: "secret123", ownerPassword: "owner-secret" });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(12).text("CAMS Consolidated Account Statement");
    doc.fontSize(5).text(`AGM-CAS-JSON:${Buffer.from(JSON.stringify(payload)).toString("base64url")} END-AGM-CAS`, { width: 500 });
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

  const response = await request("/api/cas/upload", { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  assert.ok(payload.clientId);

  const clientResponse = await request(`/api/clients/${payload.clientId}`);
  const clientPayload = await clientResponse.json();
  assert.equal(clientPayload.client.name, "New CAS Client");
  assert.equal(clientPayload.client.pan, "FGHIJ5678K");
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
