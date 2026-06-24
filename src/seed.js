import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { loadEnv, projectRoot } from "./config.js";
import { closeDb, db, initDb, transaction, getSettings } from "./db.js";
import { normalizeHolding } from "./cas/normalize.js";
import { buildAnalytics } from "./analytics.js";
import { buildRecommendations } from "./recommendations.js";

async function generatePdf(fixture) {
  const sampleDirectory = path.join(projectRoot, "samples");
  fs.mkdirSync(sampleDirectory, { recursive: true });
  const destination = path.join(sampleDirectory, "sample-protected-cas.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ userPassword: "ABCDE1234F", ownerPassword: "agm-sample-owner" });
    const stream = fs.createWriteStream(destination);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);
    doc.fontSize(16).text("CAMS Consolidated Account Statement");
    doc.fontSize(10).text("Synthetic statement for AGM Wealth application testing only.");
    const encoded = Buffer.from(JSON.stringify(fixture)).toString("base64url");
    doc.fontSize(5).text(`AGM-CAS-JSON:${encoded} END-AGM-CAS`, { width: 500 });
    doc.end();
  });
  return destination;
}

export async function seedSample() {
  const config = loadEnv();
  initDb(config);
  try {
    const fixturePath = path.join(projectRoot, "samples", "sample-cas.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    fixture.source = "CAMS";
    fixture.holdings = fixture.holdings.map(normalizeHolding);

    const admin = db().prepare("SELECT id FROM users WHERE email=?").get(config.adminEmail);
    const existing = db().prepare("SELECT id FROM clients WHERE pan=?").get(fixture.investor.pan);
    if (!existing) {
      transaction(() => {
        const clientResult = db()
          .prepare("INSERT INTO clients (name,pan,email,mobile,risk_profile,created_by) VALUES (?,?,?,?,?,?)")
          .run(fixture.investor.name, fixture.investor.pan, fixture.investor.email, fixture.investor.mobile, "Moderate", admin.id);
        const analytics = buildAnalytics(fixture.holdings, getSettings());
        const reportResult = db()
          .prepare("INSERT INTO reports (client_id,source,statement_date,portfolio_json,analytics_json,created_by) VALUES (?,?,?,?,?,?)")
          .run(clientResult.lastInsertRowid, fixture.source, fixture.statementDate, JSON.stringify(fixture), JSON.stringify(analytics), admin.id);
        const insert = db().prepare(
          `INSERT INTO recommendations
           (report_id,holding_key,system_action,system_reason,final_action,client_note,internal_note,updated_by)
           VALUES (?,?,?,?,?,?,?,?)`,
        );
        for (const item of buildRecommendations(fixture.holdings, getSettings())) {
          insert.run(reportResult.lastInsertRowid, item.holdingKey, item.systemAction, item.systemReason, item.finalAction, item.clientNote, item.internalNote, admin.id);
        }
        db().prepare("INSERT INTO internal_notes (report_id,updated_by) VALUES (?,?)").run(reportResult.lastInsertRowid, admin.id);
      });
    }

    const pdfPath = await generatePdf(fixture);
    console.log(`Sample client data is ready. Protected CAS: ${pdfPath}`);
    console.log("Sample CAS password: ABCDE1234F");
  } finally {
    closeDb();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  seedSample().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
