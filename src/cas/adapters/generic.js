import { CasAdapter } from "./base.js";

const moneyPattern = /(?:₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,4})?)/gi;

export class GenericCasAdapter extends CasAdapter {
  constructor() {
    super("Generic CAS");
  }

  matches() {
    return true;
  }

  parse(text) {
    if (text.includes("AGM-CAS-JSON:")) {
      const encoded = text
        .match(/AGM-CAS-JSON:\s*([A-Za-z0-9_\-\s]+?)\s*END-AGM-CAS/)?.[1]
        ?.replace(/\s/g, "");
      if (!encoded) throw new Error("The embedded CAS test payload is incomplete.");
      return this.normalize(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    }

    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pan = text.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/)?.[0] || "";
    const email = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || "";
    const mobile = text.match(/(?:\+91[-\s]?)?[6-9]\d{9}/)?.[0] || "";
    const name = lines.find((line) => /investor|unit holder|name/i.test(line))?.replace(/^.*?:\s*/, "") || "";
    const holdings = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/(fund|scheme|plan|growth|idcw|dividend|elss|liquid|equity|debt|hybrid)/i.test(line)) continue;
      const values = [...line.matchAll(moneyPattern)].map((match) => Number(match[1].replaceAll(",", "")));
      if (!values.length) continue;
      holdings.push({
        folio: line.match(/\b\d{4,}\/?\d*\b/)?.[0] || "",
        amc: line.match(/(HDFC|ICICI|SBI|Nippon|Kotak|Axis|Aditya Birla|UTI|Mirae|Parag Parikh|DSP|Franklin|Tata|Canara|Motilal|Quant|Bandhan|Invesco|HSBC|Mahindra)[^,\d]*/i)?.[0] || "Unknown AMC",
        schemeName: line.replace(moneyPattern, "").replace(/\s{2,}/g, " ").trim(),
        currentValue: values.at(-1),
        costValue: values.length > 1 ? values.at(-2) : values.at(-1),
      });
    }

    if (!holdings.length) {
      throw new Error("No mutual fund holdings could be identified. Try a detailed CAS from CAMS, KFintech or MF Central.");
    }
    return this.normalize({ investor: { name, pan, email, mobile }, holdings, warnings: ["Generic line parser used; verify extracted values before sharing."] });
  }
}
