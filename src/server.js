import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import { loadEnv, projectRoot } from "./config.js";
import { audit, checkDb, closeDb, db, getSettings, initDb, transaction } from "./db.js";
import { hashPassword, parseCookies, sha256, token, verifyPassword } from "./security.js";
import { parseCasPdf } from "./cas/parser.js";
import { buildAnalytics } from "./analytics.js";
import { ACTIONS, buildRecommendations } from "./recommendations.js";
import { buildSwpProjection } from "./swp.js";
import { streamPdfReport, writeExcelReport } from "./reports.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = projectRoot;
const config = loadEnv();
const appRevision = "cams-family-v7";
initDb(config);

const brandingPath = path.join(config.storagePath, "branding");
fs.mkdirSync(config.uploadTmpPath, { recursive: true });
fs.mkdirSync(brandingPath, { recursive: true });

const app = express();
const loginAttempts = new Map();
app.disable("x-powered-by");
if (config.production) app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "connect-src": ["'self'"],
        "upgrade-insecure-requests": config.production ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  dest: config.uploadTmpPath,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 20 },
  fileFilter(_request, file, callback) {
    const isPdf = file.mimetype === "application/pdf" && file.originalname.toLowerCase().endsWith(".pdf");
    callback(isPdf ? null : new Error("Only PDF files are accepted."), isPdf);
  },
});

function setSessionCookie(response, rawToken, expiresAt) {
  const attributes = [
    `agm_session=${rawToken}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.production) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `agm_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${config.production ? "; Secure" : ""}`,
  );
}

function authenticate(request, response, next) {
  const raw = parseCookies(request.headers.cookie).agm_session;
  if (!raw) return response.status(401).json({ error: "Authentication required." });
  const session = db()
    .prepare(
      `SELECT sessions.*, users.name, users.email, users.role, users.active
       FROM sessions JOIN users ON users.id=sessions.user_id
       WHERE sessions.token_hash=? AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP`,
    )
    .get(sha256(raw));
  if (!session || !session.active) {
    clearSessionCookie(response);
    return response.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  request.user = { id: session.user_id, name: session.name, email: session.email, role: session.role };
  request.session = session;
  next();
}

function requireAdmin(request, response, next) {
  if (request.user.role !== "admin") return response.status(403).json({ error: "Admin access is required." });
  next();
}

function verifyMutation(request, response, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const origin = request.headers.origin;
  if (origin && origin !== config.origin) return response.status(403).json({ error: "Origin check failed." });
  if (request.headers["x-csrf-token"] !== request.session.csrf_token) {
    return response.status(403).json({ error: "Security token is missing or invalid." });
  }
  next();
}

function validPan(value) {
  return !value || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value);
}

function validEmail(value) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validRiskProfile(value) {
  return ["Conservative", "Moderate", "Aggressive"].includes(value);
}

function publicAppConfig() {
  const settings = getSettings();
  return {
    maxUploadMb: config.maxUploadMb,
    logoUrl: settings.logoUrl || "/branding/logo.png",
  };
}

function mapReport(row) {
  const portfolio = row.portfolio_json ? JSON.parse(row.portfolio_json) : undefined;
  let analytics = row.analytics_json ? JSON.parse(row.analytics_json) : undefined;
  if (portfolio?.holdings && !Array.isArray(analytics?.holdingReturns)) {
    analytics = buildAnalytics(portfolio.holdings, getSettings(), row.statement_date || portfolio.statementDate);
  }
  return {
    ...row,
    portfolio,
    analytics,
    swp: row.swp_json ? JSON.parse(row.swp_json) : null,
    portfolio_json: undefined,
    analytics_json: undefined,
    swp_json: undefined,
  };
}

app.get("/healthz", (_request, response) => {
  try {
    db().prepare("SELECT 1 ok").get();
    response.json({ status: "ok", revision: appRevision });
  } catch {
    response.status(503).json({ status: "unavailable" });
  }
});

app.get("/readyz", (_request, response) => {
  try {
    const health = checkDb();
    const ready = health.integrity.every((value) => value === "ok") && health.foreignKeys.length === 0;
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "invalid", revision: appRevision, migrations: health.migrations.map((row) => row.version) });
  } catch {
    response.status(503).json({ status: "unavailable" });
  }
});

app.post("/api/auth/login", (request, response) => {
  const attemptKey = request.ip || request.socket.remoteAddress || "unknown";
  let attempt = loginAttempts.get(attemptKey);
  if (attempt && Date.now() - attempt.firstFailureAt > 15 * 60_000) {
    loginAttempts.delete(attemptKey);
    attempt = null;
  }
  if (attempt && attempt.blockedUntil > Date.now()) {
    response.setHeader("Retry-After", Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
    return response.status(429).json({ error: "Too many sign-in attempts. Try again in a few minutes." });
  }
  const email = String(request.body.email || "").trim().toLowerCase();
  const password = String(request.body.password || "");
  const user = db().prepare("SELECT * FROM users WHERE email=? AND active=1").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const failures = (attempt?.failures || 0) + 1;
    loginAttempts.set(attemptKey, {
      failures,
      firstFailureAt: attempt?.firstFailureAt || Date.now(),
      blockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : 0,
    });
    audit(user?.id, "login_failed", "user", user?.id, { email });
    return response.status(401).json({ error: "Invalid email or password." });
  }
  loginAttempts.delete(attemptKey);
  db().prepare("DELETE FROM sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP").run();
  const rawToken = token();
  const csrfToken = token(20);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000).toISOString();
  db().prepare("INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)").run(sha256(rawToken), user.id, csrfToken, expiresAt);
  setSessionCookie(response, rawToken, expiresAt);
  audit(user.id, "login", "user", user.id);
  response.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    csrfToken,
    appConfig: publicAppConfig(),
  });
});

app.get("/api/auth/me", authenticate, (request, response) => {
  response.json({
    user: request.user,
    csrfToken: request.session.csrf_token,
    appConfig: publicAppConfig(),
  });
});

app.post("/api/auth/logout", authenticate, verifyMutation, (request, response) => {
  const raw = parseCookies(request.headers.cookie).agm_session;
  db().prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(raw));
  audit(request.user.id, "logout", "user", request.user.id);
  clearSessionCookie(response);
  response.status(204).end();
});

app.use("/api", authenticate, verifyMutation);

app.get("/api/dashboard", (request, response) => {
  const stats = {
    clients: db().prepare("SELECT COUNT(*) count FROM clients").get().count,
    reports: db().prepare("SELECT COUNT(*) count FROM reports").get().count,
    portfolioValue: db().prepare("SELECT portfolio_json FROM reports").all().reduce((sum, row) => sum + (JSON.parse(row.portfolio_json).holdings || []).reduce((subtotal, item) => subtotal + item.currentValue, 0), 0),
    reviewsThisMonth: db().prepare("SELECT COUNT(*) count FROM reports WHERE created_at >= date('now','start of month')").get().count,
  };
  const recent = db()
    .prepare(
      `SELECT reports.id, reports.client_id, reports.source, reports.created_at, clients.name client_name,
       json_extract(reports.analytics_json,'$.totalValue') total_value
       FROM reports JOIN clients ON clients.id=reports.client_id ORDER BY reports.created_at DESC LIMIT 8`,
    )
    .all();
  response.json({ stats, recent });
});

app.get("/api/clients", (request, response) => {
  const search = `%${String(request.query.search || "").trim()}%`;
  const clients = db()
    .prepare(
      `SELECT clients.*, COUNT(reports.id) report_count, MAX(reports.created_at) last_report_at
       FROM clients LEFT JOIN reports ON reports.client_id=clients.id
       WHERE clients.name LIKE ? OR clients.pan LIKE ? OR clients.mobile LIKE ? OR clients.email LIKE ?
       GROUP BY clients.id ORDER BY clients.updated_at DESC LIMIT 200`,
    )
    .all(search, search, search, search);
  response.json({ clients });
});

app.post("/api/clients", (request, response) => {
  const client = {
    name: String(request.body.name || "").trim(),
    pan: String(request.body.pan || "").trim().toUpperCase(),
    email: String(request.body.email || "").trim().toLowerCase(),
    mobile: String(request.body.mobile || "").replace(/\D/g, ""),
    riskProfile: String(request.body.riskProfile || "Moderate"),
  };
  if (client.name.length < 2) return response.status(400).json({ error: "Client name is required." });
  if (!validPan(client.pan)) return response.status(400).json({ error: "Enter a valid PAN, for example ABCDE1234F." });
  if (!validEmail(client.email)) return response.status(400).json({ error: "Enter a valid email address." });
  if (!validRiskProfile(client.riskProfile)) return response.status(400).json({ error: "Choose a valid risk profile." });
  if (client.pan && db().prepare("SELECT id FROM clients WHERE pan=?").get(client.pan)) {
    return response.status(409).json({ error: "A client with this PAN already exists." });
  }
  let result;
  try {
    result = db()
      .prepare("INSERT INTO clients (name,pan,email,mobile,risk_profile,created_by) VALUES (?,?,?,?,?,?)")
      .run(client.name, client.pan || null, client.email || null, client.mobile || null, client.riskProfile, request.user.id);
  } catch (error) {
    if (/UNIQUE constraint failed: clients\.pan/.test(error.message)) {
      return response.status(409).json({ error: "A client with this PAN already exists." });
    }
    throw error;
  }
  audit(request.user.id, "create", "client", result.lastInsertRowid);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...client });
});

app.get("/api/clients/:id", (request, response) => {
  const client = db().prepare("SELECT * FROM clients WHERE id=?").get(request.params.id);
  if (!client) return response.status(404).json({ error: "Client not found." });
  const reports = db()
    .prepare("SELECT id,source,statement_date,status,analytics_json,created_at FROM reports WHERE client_id=? ORDER BY created_at DESC")
    .all(client.id)
    .map(mapReport);
  response.json({ client, reports });
});

app.put("/api/clients/:id", (request, response) => {
  const name = String(request.body.name || "").trim();
  const pan = String(request.body.pan || "").trim().toUpperCase();
  const email = String(request.body.email || "").trim().toLowerCase();
  const riskProfile = String(request.body.riskProfile || "Moderate");
  if (name.length < 2) return response.status(400).json({ error: "Client name is required." });
  if (!validPan(pan)) return response.status(400).json({ error: "Enter a valid PAN." });
  if (!validEmail(email)) return response.status(400).json({ error: "Enter a valid email address." });
  if (!validRiskProfile(riskProfile)) return response.status(400).json({ error: "Choose a valid risk profile." });
  const duplicate = pan
    ? db().prepare("SELECT id FROM clients WHERE pan=? AND id<>?").get(pan, request.params.id)
    : null;
  if (duplicate) return response.status(409).json({ error: "Another client already uses this PAN." });
  const result = db()
    .prepare("UPDATE clients SET name=?,pan=?,email=?,mobile=?,risk_profile=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(name, pan || null, email || null, String(request.body.mobile || "").replace(/\D/g, "") || null, riskProfile, request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Client not found." });
  audit(request.user.id, "update", "client", request.params.id);
  response.json({ ok: true });
});

app.delete("/api/clients/:id", requireAdmin, (request, response) => {
  const result = db().prepare("DELETE FROM clients WHERE id=?").run(request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Client not found." });
  audit(request.user.id, "delete", "client", request.params.id);
  response.status(204).end();
});

app.post("/api/cas/upload", upload.single("cas"), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: "Choose a CAS PDF to upload." });
  try {
    const parsed = await parseCasPdf(request.file.path, String(request.body.password || ""), { maxPages: config.maxCasPages });
    if (!parsed.holdings.length) return response.status(422).json({ error: "No holdings were found in this CAS." });
    const settings = getSettings();
    const createReportForClient = (targetClient, portfolio) => {
      const analytics = buildAnalytics(portfolio.holdings, settings, portfolio.statementDate);
      const reportResult = db()
        .prepare("INSERT INTO reports (client_id,source,statement_date,portfolio_json,analytics_json,created_by) VALUES (?,?,?,?,?,?)")
        .run(targetClient.id, portfolio.source || parsed.source, portfolio.statementDate, JSON.stringify(portfolio), JSON.stringify(analytics), request.user.id);
      const reportId = Number(reportResult.lastInsertRowid);
      const insertRecommendation = db().prepare(
        `INSERT INTO recommendations
        (report_id,holding_key,system_action,system_reason,final_action,client_note,internal_note,updated_by)
        VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const item of buildRecommendations(portfolio.holdings, settings)) {
        insertRecommendation.run(reportId, item.holdingKey, item.systemAction, item.systemReason, item.finalAction, item.clientNote, item.internalNote, request.user.id);
      }
      db().prepare("INSERT INTO internal_notes (report_id,updated_by) VALUES (?,?)").run(reportId, request.user.id);
      return reportId;
    };

    if (request.body.familyMode === "1") {
      const accounts = (parsed.accounts || []).filter((account) => account.holdings?.length);
      if (accounts.length < 2) {
        return response.status(422).json({ error: "Family mode is on, but the CAS did not expose more than one investor clearly. Upload individual CAS files or use normal upload for this file." });
      }
      const familyName = String(request.body.newClientName || "").trim();
      const riskProfile = String(request.body.newClientRiskProfile || "Moderate");
      if (!validRiskProfile(riskProfile)) return response.status(400).json({ error: "Choose a valid risk profile." });
      const familyReports = transaction(() =>
        accounts.map((account, index) => {
          const accountInvestor = account.investor || {};
          const memberName = String(accountInvestor.name || (familyName ? `${familyName} - Member ${index + 1}` : "")).trim();
          const memberPan = String(accountInvestor.pan || "").trim().toUpperCase();
          if (memberName.length < 2) {
            const error = new Error("Family CAS found a member without a readable name. Enter a family name/prefix and upload again, or upload that member separately.");
            error.status = 400;
            throw error;
          }
          if (memberPan && !validPan(memberPan)) {
            const error = new Error(`${memberName}'s PAN was not readable or valid. Upload that member separately or correct the CAS source.`);
            error.status = 400;
            throw error;
          }
          let familyClient = memberPan
            ? db().prepare("SELECT * FROM clients WHERE pan=?").get(memberPan)
            : db().prepare("SELECT * FROM clients WHERE lower(name)=lower(?) AND pan IS NULL").get(memberName);
          if (!familyClient) {
            const clientResult = db()
              .prepare("INSERT INTO clients (name,pan,email,mobile,risk_profile,created_by) VALUES (?,?,?,?,?,?)")
              .run(memberName, memberPan || null, accountInvestor.email || null, String(accountInvestor.mobile || "").replace(/\D/g, "") || null, riskProfile, request.user.id);
            familyClient = { id: Number(clientResult.lastInsertRowid), name: memberName, pan: memberPan };
            audit(request.user.id, "create_from_family_cas", "client", familyClient.id);
          }
          const portfolio = {
            source: parsed.source,
            investor: accountInvestor,
            statementDate: account.statementDate || parsed.statementDate,
            holdings: account.holdings,
            warnings: account.warnings || parsed.warnings || [],
          };
          const reportId = createReportForClient(familyClient, portfolio);
          audit(request.user.id, "upload_family_member", "report", reportId, { source: parsed.source, holdings: account.holdings.length, clientId: familyClient.id });
          return { reportId, clientId: familyClient.id, clientName: familyClient.name, pan: familyClient.pan };
        }),
      );
      return response.status(201).json({
        reportId: familyReports[0]?.reportId,
        clientId: familyReports[0]?.clientId,
        familyReports,
        source: parsed.source,
        warnings: parsed.warnings,
      });
    }

    const createNewClient = request.body.clientId === "__new__" || !request.body.clientId;
    let client = createNewClient
      ? null
      : db().prepare("SELECT * FROM clients WHERE id=?").get(request.body.clientId);
    if (!createNewClient && !client) return response.status(404).json({ error: "Client not found." });

    const newClient = createNewClient
      ? {
          name: String(request.body.newClientName || parsed.investor.name || "").trim(),
          pan: String(request.body.newClientPan || parsed.investor.pan || "").trim().toUpperCase(),
          email: String(request.body.newClientEmail || parsed.investor.email || "").trim().toLowerCase(),
          mobile: String(request.body.newClientMobile || parsed.investor.mobile || "").replace(/\D/g, ""),
          riskProfile: String(request.body.newClientRiskProfile || "Moderate"),
        }
      : null;
    if (newClient && newClient.name.length < 2) {
      return response.status(400).json({ error: "Type the client's name in the New client name field, then upload the CAS again." });
    }
    if (newClient && !validPan(newClient.pan)) {
      return response.status(400).json({ error: "The new client PAN is not valid. Correct it and try again." });
    }
    if (newClient && !validEmail(newClient.email)) {
      return response.status(400).json({ error: "The new client email address is not valid." });
    }
    if (newClient && !validRiskProfile(newClient.riskProfile)) {
      return response.status(400).json({ error: "Choose a valid risk profile." });
    }
    if (newClient?.pan) {
      const duplicate = db().prepare("SELECT id,name FROM clients WHERE pan=?").get(newClient.pan);
      if (duplicate) {
        return response.status(409).json({
          error: `${duplicate.name} already uses this PAN. Choose that existing client instead of creating a duplicate.`,
        });
      }
    }

    const createReport = () => {
      if (newClient) {
        const clientResult = db()
          .prepare("INSERT INTO clients (name,pan,email,mobile,risk_profile,created_by) VALUES (?,?,?,?,?,?)")
          .run(
            newClient.name,
            newClient.pan || null,
            newClient.email || null,
            newClient.mobile || null,
            newClient.riskProfile,
            request.user.id,
          );
        client = { id: Number(clientResult.lastInsertRowid), ...newClient };
        audit(request.user.id, "create_from_cas", "client", client.id);
      }
      return createReportForClient(client, parsed);
    };
    const reportId = transaction(createReport);
    audit(request.user.id, "upload_and_parse", "report", reportId, { source: parsed.source, holdings: parsed.holdings.length });
    response.status(201).json({ reportId, clientId: client.id, source: parsed.source, warnings: parsed.warnings });
  } catch (error) {
    response.status(error.status || (error.code === "PDF_PASSWORD" ? 400 : 422)).json({ error: error.message || "CAS processing failed." });
  } finally {
    await fsp.rm(request.file.path, { force: true });
  }
});

app.get("/api/reports/:id", (request, response) => {
  const report = db()
    .prepare(
      `SELECT reports.*, clients.name client_name, clients.pan, clients.email, clients.mobile, clients.risk_profile
       FROM reports JOIN clients ON clients.id=reports.client_id WHERE reports.id=?`,
    )
    .get(request.params.id);
  if (!report) return response.status(404).json({ error: "Report not found." });
  const recommendations = db().prepare("SELECT * FROM recommendations WHERE report_id=? ORDER BY id").all(report.id);
  const internalNotes = db().prepare("SELECT * FROM internal_notes WHERE report_id=?").get(report.id);
  const models = db().prepare("SELECT id,name,risk_level,items_json,assumptions_json FROM model_portfolios ORDER BY name").all().map((row) => ({ ...row, items: JSON.parse(row.items_json), assumptions: JSON.parse(row.assumptions_json), items_json: undefined, assumptions_json: undefined }));
  response.json({ report: mapReport(report), recommendations, internalNotes, models, actions: ACTIONS });
});

app.put("/api/reports/:id/plan", (request, response) => {
  const modelId = request.body.modelId ? Number(request.body.modelId) : null;
  if (modelId && !db().prepare("SELECT id FROM model_portfolios WHERE id=?").get(modelId)) {
    return response.status(400).json({ error: "Selected model portfolio was not found." });
  }
  const swp = request.body.swp ? buildSwpProjection(request.body.swp) : null;
  const result = db().prepare("UPDATE reports SET model_portfolio_id=?,swp_json=? WHERE id=?").run(modelId, swp ? JSON.stringify(swp) : null, request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Report not found." });
  audit(request.user.id, "update", "report_plan", request.params.id, { modelId, hasSwp: Boolean(swp) });
  response.json({ swp });
});

app.put("/api/reports/:id/recommendations", (request, response) => {
  const report = db().prepare("SELECT id FROM reports WHERE id=?").get(request.params.id);
  if (!report) return response.status(404).json({ error: "Report not found." });
  const update = db().prepare(
    `UPDATE recommendations SET final_action=?,client_note=?,internal_note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
     WHERE report_id=? AND holding_key=?`,
  );
  const saveRecommendations = () => {
    for (const item of request.body.recommendations || []) {
      if (!ACTIONS.includes(item.finalAction)) throw new Error("Invalid recommendation action.");
      update.run(item.finalAction, String(item.clientNote || ""), String(item.internalNote || ""), request.user.id, report.id, item.holdingKey);
    }
  };
  try {
    transaction(saveRecommendations);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
  audit(request.user.id, "update", "recommendations", report.id);
  response.json({ ok: true });
});

app.put("/api/reports/:id/internal-notes", (request, response) => {
  const result = db()
    .prepare(
      `UPDATE internal_notes SET tax_check=?,exit_load_check=?,lock_in_check=?,discussion_points=?,
       execution_status=?,follow_up_date=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE report_id=?`,
    )
    .run(request.body.taxCheck ? 1 : 0, request.body.exitLoadCheck ? 1 : 0, request.body.lockInCheck ? 1 : 0, String(request.body.discussionPoints || ""), String(request.body.executionStatus || "Pending"), request.body.followUpDate || null, request.user.id, request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Report not found." });
  audit(request.user.id, "update", "internal_notes", request.params.id);
  response.json({ ok: true });
});

app.get("/api/reports/:id/pdf", (request, response) => {
  if (!db().prepare("SELECT id FROM reports WHERE id=?").get(request.params.id)) {
    return response.status(404).json({ error: "Report not found." });
  }
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `attachment; filename="agm-wealth-review-${request.params.id}.pdf"`);
  audit(request.user.id, "generate", "pdf_report", request.params.id);
  streamPdfReport(request.params.id, response, { includeInternal: request.query.internal === "1" && request.user.role === "admin" });
});

app.get("/api/reports/:id/excel", async (request, response, next) => {
  try {
    if (!db().prepare("SELECT id FROM reports WHERE id=?").get(request.params.id)) {
      return response.status(404).json({ error: "Report not found." });
    }
    response.setHeader("Content-Disposition", `attachment; filename="agm-wealth-review-${request.params.id}.xlsx"`);
    audit(request.user.id, "generate", "excel_report", request.params.id);
    await writeExcelReport(request.params.id, response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/swp", (request, response) => response.json(buildSwpProjection(request.body)));

app.get("/api/models", (_request, response) => {
  const models = db().prepare("SELECT * FROM model_portfolios ORDER BY updated_at DESC").all().map((row) => ({ ...row, items: JSON.parse(row.items_json), assumptions: JSON.parse(row.assumptions_json), items_json: undefined, assumptions_json: undefined }));
  response.json({ models });
});

app.post("/api/models", (request, response) => {
  const name = String(request.body.name || "").trim();
  if (!name) return response.status(400).json({ error: "Model portfolio name is required." });
  const items = Array.isArray(request.body.items) ? request.body.items : [];
  const allocation = items.reduce((sum, item) => sum + Number(item.allocation || 0), 0);
  if (!items.length || Math.abs(allocation - 100) > 0.01) {
    return response.status(400).json({ error: "Model portfolio allocation must contain rows totalling 100%." });
  }
  const result = db()
    .prepare("INSERT INTO model_portfolios (name,risk_level,items_json,assumptions_json,created_by) VALUES (?,?,?,?,?)")
    .run(name, String(request.body.riskLevel || "Moderate"), JSON.stringify(items), JSON.stringify(request.body.assumptions || {}), request.user.id);
  audit(request.user.id, "create", "model_portfolio", result.lastInsertRowid);
  response.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put("/api/models/:id", (request, response) => {
  const name = String(request.body.name || "").trim();
  const items = Array.isArray(request.body.items) ? request.body.items : [];
  const allocation = items.reduce((sum, item) => sum + Number(item.allocation || 0), 0);
  if (!name || !items.length || Math.abs(allocation - 100) > 0.01) {
    return response.status(400).json({ error: "Model name and allocation rows totalling 100% are required." });
  }
  const result = db()
    .prepare("UPDATE model_portfolios SET name=?,risk_level=?,items_json=?,assumptions_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(name, String(request.body.riskLevel || "Moderate"), JSON.stringify(items), JSON.stringify(request.body.assumptions || {}), request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Model portfolio not found." });
  audit(request.user.id, "update", "model_portfolio", request.params.id);
  response.json({ ok: true });
});

app.delete("/api/models/:id", requireAdmin, (request, response) => {
  const linked = db().prepare("SELECT COUNT(*) count FROM reports WHERE model_portfolio_id=?").get(request.params.id).count;
  if (linked) return response.status(409).json({ error: "This model is attached to a report. Detach it before deleting the model." });
  const result = db().prepare("DELETE FROM model_portfolios WHERE id=?").run(request.params.id);
  if (!result.changes) return response.status(404).json({ error: "Model portfolio not found." });
  audit(request.user.id, "delete", "model_portfolio", request.params.id);
  response.status(204).end();
});

app.get("/api/settings", (_request, response) => response.json({ settings: getSettings() }));

app.put("/api/settings", requireAdmin, (request, response) => {
  const allowed = ["companyName", "address", "arn", "euin", "reportFooter", "disclaimer", "defaultReturn", "smallHoldingThreshold", "concentrationThreshold", "recommendedFunds", "categoriesToAvoid"];
  const upsert = db().prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
  );
  const saveSettings = () => {
    for (const key of allowed) if (key in request.body) upsert.run(key, JSON.stringify(request.body[key]));
  };
  transaction(saveSettings);
  audit(request.user.id, "update", "settings", "company");
  response.json({ settings: getSettings() });
});

const logoUpload = multer({
  dest: config.uploadTmpPath,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(_request, file, callback) {
    callback(null, ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype));
  },
});
app.post("/api/settings/logo", requireAdmin, logoUpload.single("logo"), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: "Choose a PNG, JPEG or WebP logo." });
  try {
    const bytes = await fsp.readFile(request.file.path);
    const validImage =
      (request.file.mimetype === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (request.file.mimetype === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) ||
      (request.file.mimetype === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
    if (!validImage) return response.status(400).json({ error: "The uploaded file content is not a valid PNG, JPEG or WebP image." });
    const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[request.file.mimetype];
    const destination = path.join(brandingPath, `logo${extension}`);
    await fsp.copyFile(request.file.path, destination);
    db().prepare("INSERT INTO settings (key,value) VALUES ('logoUrl',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(`/branding/logo${extension}`));
    audit(request.user.id, "upload", "company_logo", "logo");
    response.json({ logoUrl: `/branding/logo${extension}` });
  } finally {
    await fsp.rm(request.file.path, { force: true });
  }
});

app.get("/api/users", requireAdmin, (_request, response) => {
  response.json({ users: db().prepare("SELECT id,name,email,role,active,created_at FROM users ORDER BY created_at").all() });
});
app.post("/api/users", requireAdmin, (request, response) => {
  const password = String(request.body.password || "");
  const name = String(request.body.name || "").trim();
  const email = String(request.body.email || "").trim().toLowerCase();
  if (name.length < 2) return response.status(400).json({ error: "User name is required." });
  if (!validEmail(email)) return response.status(400).json({ error: "Enter a valid user email address." });
  if (password.length < 12) return response.status(400).json({ error: "Password must be at least 12 characters." });
  try {
    const result = db().prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)").run(name, email, hashPassword(password), request.body.role === "admin" ? "admin" : "staff");
    audit(request.user.id, "create", "user", result.lastInsertRowid);
    response.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch {
    response.status(409).json({ error: "A user with this email already exists." });
  }
});

app.get("/api/audit", requireAdmin, (_request, response) => {
  response.json({ events: db().prepare("SELECT audit_log.*,users.name user_name FROM audit_log LEFT JOIN users ON users.id=audit_log.user_id ORDER BY audit_log.created_at DESC LIMIT 200").all() });
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API endpoint not found." }));
app.use("/branding", express.static(brandingPath, { etag: true, maxAge: "1h" }));
app.use(express.static(path.join(root, "public"), {
  index: "index.html",
  etag: true,
  maxAge: 0,
  setHeaders(response) {
    response.setHeader("Cache-Control", "no-cache");
  },
}));
app.get(/.*/, (_request, response) => response.sendFile(path.join(root, "public", "index.html")));

app.use((error, _request, response, _next) => {
  console.error(error);
  if (response.headersSent) return response.end();
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({ error: `File exceeds the ${config.maxUploadMb} MB limit.` });
  }
  if (/Only PDF files|PNG, JPEG or WebP/.test(error.message || "")) {
    return response.status(400).json({ error: error.message });
  }
  response.status(error.status || 500).json({ error: config.production ? "Unexpected server error." : error.message || "Unexpected server error." });
});

export function startServer() {
  const server = app.listen(config.port, config.host, () => {
    console.log(`AGM Wealth is running at ${config.origin}`);
  });
  server.on("error", (error) => {
    console.error(`Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

export { app, config };
