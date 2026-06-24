import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fileEnv(envPath = path.join(projectRoot, ".env")) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

export function loadEnv() {
  const env = { ...fileEnv(), ...process.env };
  const config = {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    origin: (env.APP_ORIGIN || `http://127.0.0.1:${env.PORT || 3000}`).replace(/\/+$/, ""),
    databasePath: path.resolve(projectRoot, env.DATABASE_PATH || "./data/agm-wealth.sqlite"),
    storagePath: path.resolve(projectRoot, env.STORAGE_PATH || "./data"),
    uploadTmpPath: path.resolve(projectRoot, env.UPLOAD_TMP_PATH || path.join(os.tmpdir(), "agm-wealth-uploads")),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    adminEmail: (env.ADMIN_EMAIL || "kamlesh@agmwealth.com").trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || "ChangeMeNow!123",
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 15),
    maxCasPages: Number(env.MAX_CAS_PAGES || 500),
    production: env.NODE_ENV === "production",
    projectRoot,
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (!Number.isFinite(config.sessionTtlHours) || config.sessionTtlHours <= 0 || config.sessionTtlHours > 168) {
    throw new Error("SESSION_TTL_HOURS must be between 0 and 168.");
  }
  if (!Number.isFinite(config.maxUploadMb) || config.maxUploadMb < 1 || config.maxUploadMb > 100) {
    throw new Error("MAX_UPLOAD_MB must be between 1 and 100.");
  }
  if (!Number.isInteger(config.maxCasPages) || config.maxCasPages < 1 || config.maxCasPages > 2000) {
    throw new Error("MAX_CAS_PAGES must be an integer between 1 and 2000.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) {
    throw new Error("ADMIN_EMAIL must be a valid email address.");
  }
  let origin;
  try {
    origin = new URL(config.origin);
  } catch {
    throw new Error("APP_ORIGIN must be a complete http:// or https:// URL.");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("APP_ORIGIN must contain only the scheme and host, without a path, query or fragment.");
  }
  if (config.production) {
    if (config.adminPassword === "ChangeMeNow!123" || config.adminPassword.length < 12) {
      throw new Error("Production requires a non-default ADMIN_PASSWORD with at least 12 characters.");
    }
    if (origin.protocol !== "https:") {
      throw new Error("Production APP_ORIGIN must use HTTPS.");
    }
  }
}
