import { GenericCasAdapter } from "./generic.js";

export class KfintechAdapter extends GenericCasAdapter {
  constructor() {
    super();
    this.name = "KFintech";
  }

  matches(text) {
    return /kfintech|karvy/i.test(text);
  }
}
