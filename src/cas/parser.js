import fs from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CamsAdapter } from "./adapters/cams.js";
import { KfintechAdapter } from "./adapters/kfintech.js";
import { MfCentralAdapter } from "./adapters/mfcentral.js";
import { GenericCasAdapter } from "./adapters/generic.js";

export const adapters = [
  new CamsAdapter(),
  new KfintechAdapter(),
  new MfCentralAdapter(),
  new GenericCasAdapter(),
];

export async function extractPdfText(filePath, password = "", { maxPages = 500 } = {}) {
  const data = new Uint8Array(await fs.readFile(filePath));
  let document;
  try {
    document = await getDocument({
      data,
      password: password || undefined,
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    if (/password/i.test(error?.name || "") || /password/i.test(error?.message || "")) {
      const readable = new Error(password ? "The PDF password is incorrect." : "This PDF is password protected. Enter its password and try again.");
      readable.code = "PDF_PASSWORD";
      throw readable;
    }
    throw new Error("The uploaded PDF could not be read.");
  }

  if (document.numPages > maxPages) {
    await document.destroy();
    throw new Error(`The CAS contains ${document.numPages} pages, exceeding the ${maxPages}-page processing limit.`);
  }
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await document.destroy();
  }
}

export function parseCasText(text) {
  const adapter = adapters.find((candidate) => candidate.matches(text));
  return adapter.parse(text);
}

export async function parseCasPdf(filePath, password = "", options) {
  return parseCasText(await extractPdfText(filePath, password, options));
}
