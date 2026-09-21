import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./security.js";

let database;

const DEFAULT_DISCLAIMER =
  "Mutual Fund investments are subject to market risks. Please read all scheme related documents carefully before investing. Past performance may or may not be sustained in future. The portfolio review and recommendation are based on available CAS/report data, current portfolio structure, investor risk profile, time horizon and assumptions provided. Taxation, exit load and lock-in implications should be checked before executing any redemption/switch transaction. This document is for discussion and review purposes only.";

export function initDb(config) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  database = new DatabaseSync(config.databasePath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','staff')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pan TEXT,
      email TEXT,
      mobile TEXT,
      risk_profile TEXT NOT NULL DEFAULT 'Moderate',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS clients_search ON clients(name, pan, mobile, email);
    CREATE TABLE IF NOT EXISTS model_portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      items_json TEXT NOT NULL,
      assumptions_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      statement_date TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      portfolio_json TEXT NOT NULL,
      analytics_json TEXT NOT NULL,
      family_batch_id TEXT,
      model_portfolio_id INTEGER REFERENCES model_portfolios(id) ON DELETE SET NULL,
      swp_json TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      holding_key TEXT NOT NULL,
      system_action TEXT NOT NULL,
      system_reason TEXT NOT NULL,
      final_action TEXT NOT NULL,
      client_note TEXT,
      internal_note TEXT,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(report_id, holding_key)
    );
    CREATE TABLE IF NOT EXISTS internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL UNIQUE REFERENCES reports(id) ON DELETE CASCADE,
      tax_check INTEGER NOT NULL DEFAULT 0,
      exit_load_check INTEGER NOT NULL DEFAULT 0,
      lock_in_check INTEGER NOT NULL DEFAULT 0,
      discussion_points TEXT,
      execution_status TEXT NOT NULL DEFAULT 'Pending',
      follow_up_date TEXT,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const reportColumns = database.prepare("PRAGMA table_info(reports)").all().map((column) => column.name);
  if (!reportColumns.includes("model_portfolio_id")) database.exec("ALTER TABLE reports ADD COLUMN model_portfolio_id INTEGER REFERENCES model_portfolios(id)");
  if (!reportColumns.includes("swp_json")) database.exec("ALTER TABLE reports ADD COLUMN swp_json TEXT");
  if (!reportColumns.includes("family_batch_id")) database.exec("ALTER TABLE reports ADD COLUMN family_batch_id TEXT");
  const duplicatePans = database
    .prepare("SELECT pan, COUNT(*) count FROM clients WHERE pan IS NOT NULL AND pan <> '' GROUP BY pan HAVING COUNT(*) > 1")
    .all();
  if (duplicatePans.length) {
    throw new Error(`Database contains duplicate PAN records: ${duplicatePans.map((row) => row.pan).join(", ")}. Resolve them before startup.`);
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS clients_pan_unique ON clients(pan) WHERE pan IS NOT NULL AND pan <> '';
    CREATE INDEX IF NOT EXISTS reports_client_created ON reports(client_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS reports_family_batch ON reports(family_batch_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at DESC);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (1), (2);
  `);

  const admin = database.prepare("SELECT id FROM users WHERE email = ?").get(config.adminEmail);
  if (!admin) {
    database
      .prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')")
      .run("AGM Wealth Admin", config.adminEmail, hashPassword(config.adminPassword));
  }

  const defaults = {
    companyName: "AGM Wealth",
    address: "Jaipur, Rajasthan",
    arn: "",
    euin: "",
    reportFooter: "AGM Wealth · Mutual Fund Distributor",
    disclaimer: DEFAULT_DISCLAIMER,
    defaultReturn: 10,
    smallHoldingThreshold: 25000,
    concentrationThreshold: 20,
    recommendedFunds: [],
    categoriesToAvoid: [],
    logoUrl: "/branding/logo.png",
  };
  const insertSetting = database.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)");
  for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, JSON.stringify(value));
  return database;
}

export function db() {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}

export function audit(userId, action, entityType, entityId, metadata = {}) {
  db()
    .prepare(
      "INSERT INTO audit_log (user_id,action,entity_type,entity_id,metadata_json) VALUES (?,?,?,?,?)",
    )
    .run(userId || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(metadata));
}

export function transaction(work) {
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

export function getSettings() {
  return Object.fromEntries(
    db()
      .prepare("SELECT key,value FROM settings")
      .all()
      .map((row) => [row.key, JSON.parse(row.value)]),
  );
}

export function closeDb() {
  database?.close();
  database = undefined;
}

export function checkDb() {
  return {
    integrity: db().prepare("PRAGMA quick_check").all().map((row) => row.quick_check),
    foreignKeys: db().prepare("PRAGMA foreign_key_check").all(),
    migrations: db().prepare("SELECT version,applied_at FROM schema_migrations ORDER BY version").all(),
  };
}
