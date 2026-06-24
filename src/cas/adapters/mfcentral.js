import { GenericCasAdapter } from "./generic.js";

export class MfCentralAdapter extends GenericCasAdapter {
  constructor() {
    super();
    this.name = "MF Central";
  }

  matches(text) {
    return /mf\s*central|mfcentral/i.test(text);
  }
}
