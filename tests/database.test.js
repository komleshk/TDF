import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDb, closeDb, db, initDb } from "../src/db.js";

const pathName = path.join(os.tmpdir(), `agm-schema-${Date.now()}.sqlite`);
const config = {
  databasePath: pathName,
  adminEmail: "schema@test.local",
  adminPassword: "SchemaPassword!123",
};

test("fresh database creates the complete schema with valid foreign keys", () => {
  initDb(config);
  const tables = db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  for (const required of [
    "users",
    "sessions",
    "clients",
    "model_portfolios",
    "reports",
    "recommendations",
    "internal_notes",
    "settings",
    "audit_log",
    "schema_migrations",
  ]) {
    assert.ok(tables.includes(required), `${required} table is missing`);
  }

  const reportColumns = db().prepare("PRAGMA table_info(reports)").all().map((row) => row.name);
  assert.ok(reportColumns.includes("model_portfolio_id"));
  assert.ok(reportColumns.includes("swp_json"));

  const health = checkDb();
  assert.deepEqual(health.integrity, ["ok"]);
  assert.deepEqual(health.foreignKeys, []);
  assert.deepEqual(health.migrations.map((row) => row.version), [1, 2]);
});

test("PAN uniqueness is enforced by the database", () => {
  const userId = db().prepare("SELECT id FROM users WHERE email=?").get(config.adminEmail).id;
  const insert = db().prepare("INSERT INTO clients (name,pan,created_by) VALUES (?,?,?)");
  insert.run("First Client", "ABCDE1234F", userId);
  assert.throws(() => insert.run("Duplicate Client", "ABCDE1234F", userId), /UNIQUE constraint/);
});

test.after(() => {
  closeDb();
  fs.rmSync(pathName, { force: true });
  fs.rmSync(`${pathName}-shm`, { force: true });
  fs.rmSync(`${pathName}-wal`, { force: true });
});
