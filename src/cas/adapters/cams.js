import { GenericCasAdapter } from "./generic.js";

export class CamsAdapter extends GenericCasAdapter {
  constructor() {
    super();
    this.name = "CAMS";
  }

  matches(text) {
    return /computer age management services|\bCAMS\b/i.test(text);
  }
}
