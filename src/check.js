import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDb, closeDb, initDb } from "./db.js";
import { loadEnv, projectRoot } from "./config.js";

function assertFile(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Required file is missing: ${relativePath}`);
}

function assertWritable(directory, label) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.agm-write-check-${Date.now()}`);
  fs.writeFileSync(probe, "ok", { flag: "wx" });
  fs.rmSync(probe);
  console.log(`✓ ${label} is writable`);
}

export function runCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  console.log(`✓ Node.js ${process.versions.node}`);

  for (const file of ["public/index.html", "public/app.js", "public/styles.css", "package.json", "database/schema.sql"]) {
    assertFile(file);
  }
  console.log("✓ Required application files are present");

  const config = loadEnv();
  assertWritable(path.dirname(config.databasePath), "Database directory");
  assertWritable(config.storagePath, "Persistent storage directory");
  assertWritable(config.uploadTmpPath, "Temporary upload directory");

  initDb(config);
  const health = checkDb();
  if (!health.integrity.every((value) => value === "ok")) {
    throw new Error(`Database integrity check failed: ${health.integrity.join(", ")}`);
  }
  if (health.foreignKeys.length) {
    throw new Error(`Database contains ${health.foreignKeys.length} foreign-key violation(s).`);
  }
  console.log(`✓ Database schema and migrations are valid (${health.migrations.map((row) => row.version).join(", ")})`);
  closeDb();
  console.log("AGM Wealth preflight check passed.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runCheck();
  } catch (error) {
    closeDb();
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
