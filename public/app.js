const state = {
  user: null,
  csrf: "",
  clients: [],
  currentReport: null,
  reportTab: "overview",
  modelItems: [],
  selectedFile: null,
  appConfig: { maxUploadMb: 15, logoUrl: "/branding/logo.png" },
};

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const esc = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function notify(message, type = "success") {
  toast.textContent = message;
  toast.className = `toast show ${type === "error" ? "error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (toast.className = "toast"), 3200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && options.body != null) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(options.method || "GET") && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  if (response.status === 401 && !path.includes("/auth/login")) {
    state.user = null;
    renderLogin();
    throw new Error("Your session expired.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "The request could not be completed.");
  }
  return response.status === 204 ? null : response.json();
}

function buttonBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function brand() {
  if (state.appConfig.logoUrl) {
    return `<div class="brand-lockup brand-lockup-logo"><img class="brand-logo" src="${esc(state.appConfig.logoUrl)}" alt="AGM Wealth" /></div>`;
  }
  return `<div class="brand-lockup"><div class="brand-mark">AGM</div><div><strong>AGM Wealth</strong><small>Portfolio Review</small></div></div>`;
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-page">
      <section class="login-brand">
        ${brand()}
        <div class="login-copy">
          <p class="eyebrow">Secure distributor workspace</p>
          <h1>Clarity for every portfolio conversation.</h1>
          <p>Upload consolidated account statements, review portfolio structure, refine recommendations and prepare client-ready reports.</p>
        </div>
        <p class="privacy-line">Client information is confidential and remains within your controlled workspace.</p>
      </section>
      <section class="login-form-wrap">
        <form class="login-card form-stack" id="loginForm">
          <div>
            <p class="eyebrow">Welcome back</p>
            <h2>Sign in to AGM Wealth</h2>
            <p>Use your distributor or staff account.</p>
          </div>
          <label class="field"><span>Email address</span><input name="email" type="email" autocomplete="username" required placeholder="kamlesh@agmwealth.com" /></label>
          <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required minlength="8" /></label>
          <p class="form-error" id="loginError"></p>
          <button class="button primary" type="submit">Secure sign in</button>
        </form>
      </section>
    </main>`;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    buttonBusy(button, true, "Signing in…");
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(values) });
      state.user = result.user;
      state.csrf = result.csrfToken;
      state.appConfig = result.appConfig || state.appConfig;
      location.hash = "#/dashboard";
      renderShell();
      route();
    } catch (error) {
      document.querySelector("#loginError").textContent = error.message;
    } finally {
      buttonBusy(button, false);
    }
  });
}

const navItems = [
  ["dashboard", "⌂", "Dashboard"],
  ["clients", "♙", "Clients"],
  ["upload", "⇧", "CAS Upload"],
  ["models", "◫", "Model Portfolios"],
  ["swp", "↗", "SWP Planner"],
  ["settings", "⚙", "Settings"],
];

function renderShell() {
  app.innerHTML = `
    <div class="app-shell" id="shell">
      <aside class="sidebar">
        ${brand()}
        <nav class="nav-list">${navItems.map(([key, icon, label]) => `<a class="nav-link" data-nav="${key}" href="#/${key}"><span class="nav-icon">${icon}</span>${label}</a>`).join("")}</nav>
        <div class="sidebar-user"><strong>${esc(state.user.name)}</strong><span>${esc(state.user.role)} · ${esc(state.user.email)}</span><button id="logout">Sign out</button></div>
      </aside>
      <div class="mobile-overlay" id="overlay"></div>
      <div class="main-shell">
        <header class="topbar">
          <button class="menu-button" id="menu" aria-label="Open menu">☰</button>
          <span class="topbar-title" id="topbarTitle">Dashboard</span>
          <span class="topbar-spacer"></span>
          <span class="secure-badge">● Secure session</span>
        </header>
        <main id="view"></main>
      </div>
    </div>`;
  document.querySelector("#menu").addEventListener("click", () => document.querySelector("#shell").classList.toggle("menu-open"));
  document.querySelector("#overlay").addEventListener("click", closeMenu);
  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", closeMenu));
  document.querySelector("#logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.csrf = "";
    history.replaceState(null, "", location.pathname);
    renderLogin();
  });
}

function closeMenu() {
  document.querySelector("#shell")?.classList.remove("menu-open");
}

function setActive(page, title) {
  document.querySelectorAll("[data-nav]").forEach((node) => node.classList.toggle("active", node.dataset.nav === page));
  const titleNode = document.querySelector("#topbarTitle");
  if (titleNode) titleNode.textContent = title;
}

function pageHeader(title, description, actions = "") {
  return `<div class="page-header"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>`;
}

function emptyState(title, copy, action = "") {
  return `<div class="empty"><div class="empty-icon">◇</div><h3>${esc(title)}</h3><p>${esc(copy)}</p>${action}</div>`;
}

async function dashboardPage() {
  setActive("dashboard", "Dashboard");
  const { stats, recent } = await api("/api/dashboard");
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader(`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, ${state.user.name.split(" ")[0]}`, "Here is the latest view of your client review workspace.", `<a class="button gold" href="#/upload">⇧ Upload CAS</a><a class="button primary" href="#/clients/new">＋ Add client</a>`)}
    <div class="stats-grid">
      ${stat("Total clients", stats.clients, "♙")}
      ${stat("CAS reports", stats.reports, "▤")}
      ${stat("Portfolio reviewed", money.format(stats.portfolioValue), "₹")}
      ${stat("Reviews this month", stats.reviewsThisMonth, "✓")}
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-header"><h2>Recent portfolio reviews</h2><a class="link small" href="#/clients">View all clients</a></div>
        ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Source</th><th>Portfolio value</th><th>Reviewed</th><th></th></tr></thead><tbody>
        ${recent.map((item) => `<tr><td><strong>${esc(item.client_name)}</strong></td><td><span class="badge">${esc(item.source)}</span></td><td class="money">${money.format(item.total_value || 0)}</td><td class="muted">${date(item.created_at)}</td><td><a class="link" href="#/reports/${item.id}">Open →</a></td></tr>`).join("")}
        </tbody></table></div>` : emptyState("No reviews yet", "Upload a client's CAS to create the first portfolio review.", `<a class="button primary" href="#/upload">Upload CAS</a>`)}
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Quick actions</h2></div>
        <div class="panel-body quick-actions">
          ${quickAction("#/clients/new", "＋", "Add a client", "Create a secure client record")}
          ${quickAction("#/upload", "⇧", "Upload CAS", "CAMS, KFintech or MF Central")}
          ${quickAction("#/models", "◫", "Build model portfolio", "Save suggested allocations")}
          ${quickAction("#/swp", "↗", "Run SWP projection", "Compare withdrawal scenarios")}
        </div>
      </section>
    </div>
  </div>`;
}

function stat(label, value, icon) {
  return `<div class="stat-card"><div class="stat-label"><span>${esc(label)}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${esc(value)}</div></div>`;
}

function quickAction(href, icon, title, copy) {
  return `<a class="quick-action" href="${href}"><span class="quick-action-icon">${icon}</span><span><strong>${esc(title)}</strong><span>${esc(copy)}</span></span></a>`;
}

async function clientsPage() {
  setActive("clients", "Clients");
  const data = await api("/api/clients");
  state.clients = data.clients;
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("Clients", "Search client records and open previous CAS reviews.", `<a class="button primary" href="#/clients/new">＋ Add client</a>`)}
    <section class="panel">
      <div class="panel-header"><div class="search"><input id="clientSearch" type="search" placeholder="Search name, PAN, mobile or email" /></div><span class="muted small" id="clientCount">${data.clients.length} clients</span></div>
      <div id="clientResults">${clientTable(data.clients)}</div>
    </section>
  </div>`;
  let timer;
  document.querySelector("#clientSearch").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const result = await api(`/api/clients?search=${encodeURIComponent(event.target.value)}`);
      document.querySelector("#clientResults").innerHTML = clientTable(result.clients);
      document.querySelector("#clientCount").textContent = `${result.clients.length} clients`;
    }, 220);
  });
}

function clientTable(clients) {
  if (!clients.length) return emptyState("No clients found", "Create a new client record or change your search.");
  return `<div class="table-wrap"><table><thead><tr><th>Client</th><th>PAN</th><th>Contact</th><th>Risk profile</th><th>Reports</th><th>Last review</th><th></th></tr></thead><tbody>
    ${clients.map((client) => `<tr><td><strong>${esc(client.name)}</strong></td><td>${esc(client.pan || "—")}</td><td><span>${esc(client.mobile || "—")}</span><br><span class="muted small">${esc(client.email || "")}</span></td><td><span class="badge gold">${esc(client.risk_profile)}</span></td><td>${client.report_count}</td><td class="muted">${date(client.last_report_at)}</td><td><a class="link" href="#/clients/${client.id}">View →</a></td></tr>`).join("")}
  </tbody></table></div>`;
}

function clientFormPage() {
  setActive("clients", "New client");
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("Add new client", "Create the client record before uploading a consolidated account statement.")}
    <section class="panel"><form class="panel-body form-stack" id="clientForm">
      <div class="form-grid">
        <label class="field"><span>Full name *</span><input name="name" required minlength="2" autocomplete="name" /></label>
        <label class="field"><span>PAN</span><input name="pan" maxlength="10" autocapitalize="characters" placeholder="ABCDE1234F" /></label>
        <label class="field"><span>Mobile</span><input name="mobile" inputmode="tel" autocomplete="tel" maxlength="15" /></label>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" /></label>
        <label class="field"><span>Risk profile</span><select name="riskProfile"><option>Conservative</option><option selected>Moderate</option><option>Aggressive</option></select></label>
      </div>
      <p class="form-error" id="formError"></p>
      <div class="form-actions"><a class="button secondary" href="#/clients">Cancel</a><button class="button primary">Create client</button></div>
    </form></section>
  </div>`;
  document.querySelector("#clientForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    buttonBusy(button, true, "Creating…");
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const client = await api("/api/clients", { method: "POST", body: JSON.stringify(values) });
      notify("Client created.");
      location.hash = `#/upload?client=${client.id}`;
    } catch (error) {
      document.querySelector("#formError").textContent = error.message;
      buttonBusy(button, false);
    }
  });
}

async function clientDetailPage(id) {
  setActive("clients", "Client details");
  const { client, reports } = await api(`/api/clients/${id}`);
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader(client.name, `${client.pan || "PAN not added"} · ${client.risk_profile} risk profile`, `<a class="button primary" href="#/upload?client=${client.id}">⇧ Upload CAS</a>`)}
    <div class="stats-grid">
      ${stat("CAS reports", reports.length, "▤")}
      ${stat("Latest value", reports[0] ? money.format(reports[0].analytics.totalValue) : "—", "₹")}
      ${stat("Mobile", client.mobile || "—", "☏")}
      ${stat("Email", client.email || "—", "@")}
    </div>
    <section class="panel"><div class="panel-header"><h2>Review history</h2></div>
    ${reports.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Source</th><th>Portfolio value</th><th>Gain/loss</th><th></th></tr></thead><tbody>
      ${reports.map((report) => `<tr><td>${date(report.created_at)}</td><td><span class="badge">${esc(report.source)}</span></td><td class="money">${money.format(report.analytics.totalValue)}</td><td class="${report.analytics.absoluteGain >= 0 ? "positive" : "negative"}">${money.format(report.analytics.absoluteGain)}</td><td><a class="link" href="#/reports/${report.id}">Open review →</a></td></tr>`).join("")}
    </tbody></table></div>` : emptyState("No CAS reports", "Upload a statement to begin this client's portfolio review.", `<a class="button primary" href="#/upload?client=${client.id}">Upload CAS</a>`)}
    </section>
  </div>`;
}

async function uploadPage(query = "") {
  setActive("upload", "CAS Upload");
  const clients = (await api("/api/clients")).clients;
  const selectedClient = new URLSearchParams(query).get("client") || "";
  state.selectedFile = null;
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("Upload CAS", "Securely process CAMS, KFintech or MF Central consolidated account statements.")}
    <form id="uploadForm" class="upload-layout">
      <section class="panel"><div class="panel-body form-stack">
        <label class="field"><span>Who is this CAS for? *</span><select name="clientId" id="uploadClient" required><option value="">Select an option</option><option value="__new__" ${selectedClient ? "" : "selected"}>＋ Create a new client from this CAS</option>${clients.map((client) => `<option value="${client.id}" ${String(client.id) === selectedClient ? "selected" : ""}>${esc(client.name)}${client.pan ? ` · ${esc(client.pan)}` : ""}</option>`).join("")}</select></label>
        <div class="form-grid" id="newClientFields">
          <label class="field"><span>New client name <small>(optional override)</small></span><input name="newClientName" minlength="2" placeholder="Read from CAS when available" /></label>
          <label class="field"><span>PAN <small>(optional override)</small></span><input name="newClientPan" maxlength="10" autocapitalize="characters" placeholder="Read from CAS when available" /></label>
          <label class="field"><span>Mobile <small>(optional)</small></span><input name="newClientMobile" inputmode="tel" /></label>
          <label class="field"><span>Email <small>(optional)</small></span><input name="newClientEmail" type="email" /></label>
          <label class="field"><span>Risk profile</span><select name="newClientRiskProfile"><option>Conservative</option><option selected>Moderate</option><option>Aggressive</option></select></label>
        </div>
        <label class="dropzone" id="dropzone">
          <input class="hidden" id="casFile" name="cas" type="file" accept="application/pdf,.pdf" required />
          <div><div class="dropzone-icon">⇧</div><h3>Choose or drop a CAS PDF</h3><p>Maximum ${esc(state.appConfig.maxUploadMb)} MB · PDF only</p><span class="button secondary">Browse PDF</span></div>
        </label>
        <div id="fileInfo"></div>
        <label class="field"><span>PDF password <small>(only if protected)</small></span><input name="password" type="password" autocomplete="off" /><small>The password is used in memory for this upload and is never saved.</small></label>
        <p class="form-error" id="uploadError"></p>
        <button class="button primary" type="submit">Process CAS and create review</button>
      </div></section>
      <aside class="panel"><div class="panel-header"><h2>Secure processing</h2></div><div class="panel-body">
        <ul class="security-list">
          <li><span>🔒</span><span><strong>Password is never stored</strong>It is used only while opening the current PDF.</span></li>
          <li><span>⌛</span><span><strong>Original file is deleted</strong>The temporary upload is removed immediately after extraction.</span></li>
          <li><span>◈</span><span><strong>Structured data is retained</strong>Only the extracted portfolio data and review history remain in the database.</span></li>
          <li><span>✓</span><span><strong>Review before sharing</strong>Verify extracted values and edit every system suggestion before report generation.</span></li>
        </ul>
      </div></aside>
    </form>
  </div>`;
  const fileInput = document.querySelector("#casFile");
  const dropzone = document.querySelector("#dropzone");
  const clientSelect = document.querySelector("#uploadClient");
  const newClientFields = document.querySelector("#newClientFields");
  const syncClientMode = () => {
    const isNew = clientSelect.value === "__new__";
    newClientFields.classList.toggle("hidden", !isNew);
  };
  clientSelect.addEventListener("change", syncClientMode);
  syncClientMode();
  const showFile = (file) => {
    state.selectedFile = file;
    document.querySelector("#fileInfo").innerHTML = file ? `<div class="file-chip"><span><strong>${esc(file.name)}</strong><br><span class="muted small">${(file.size / 1024 / 1024).toFixed(2)} MB</span></span><span class="badge green">Ready</span></div>` : "";
  };
  fileInput.addEventListener("change", () => showFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file?.type !== "application/pdf") return notify("Choose a PDF file.", "error");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showFile(file);
  });
  document.querySelector("#uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    buttonBusy(button, true, "Reading and analysing CAS…");
    try {
      const result = await api("/api/cas/upload", { method: "POST", body: new FormData(event.currentTarget) });
      notify(`CAS processed using the ${result.source} adapter.`);
      location.hash = `#/reports/${result.reportId}`;
    } catch (error) {
      document.querySelector("#uploadError").textContent = error.message;
      buttonBusy(button, false);
    }
  });
}

async function reportPage(id) {
  setActive("", "Portfolio Review");
  const payload = await api(`/api/reports/${id}`);
  state.currentReport = payload;
  state.reportTab = state.reportTab || "overview";
  renderReport();
}

function renderReport() {
  const { report, recommendations, internalNotes } = state.currentReport;
  const gainClass = report.analytics.absoluteGain >= 0 ? "positive" : "negative";
  const returnMeasure = report.analytics.xirr == null ? "Unavailable" : `${report.analytics.xirr.toFixed(2)}%`;
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader(`${report.client_name}'s portfolio`, `${report.source} CAS · reviewed ${date(report.created_at)}`, `<a class="button secondary" href="/api/reports/${report.id}/excel">↓ Excel</a><a class="button gold" href="/api/reports/${report.id}/pdf">↓ Client PDF</a>`)}
    <div class="report-summary">
      ${stat("Current value", money.format(report.analytics.totalValue), "₹")}
      ${stat("Invested cost", money.format(report.analytics.totalCost), "◫")}
      ${stat("Absolute gain/loss", `<span class="${gainClass}">${money.format(report.analytics.absoluteGain)}</span>`, "↗").replaceAll("&lt;", "<").replaceAll("&gt;", ">")}
      ${stat("Portfolio XIRR", returnMeasure, "↗")}
    </div>
    <div class="report-tabs">
      ${[["overview", "Overview"], ["holdings", "Holdings"], ["recommendations", "Recommendations"], ["plan", "Proposed plan"], ["notes", "Internal notes"]].map(([key, label]) => `<button class="report-tab ${state.reportTab === key ? "active" : ""}" data-report-tab="${key}">${label}</button>`).join("")}
    </div>
    <div id="reportContent">${reportTabContent(report, recommendations, internalNotes)}</div>
  </div>`;
  document.querySelectorAll("[data-report-tab]").forEach((button) => button.addEventListener("click", () => {
    state.reportTab = button.dataset.reportTab;
    renderReport();
  }));
  bindReportForms();
}

function reportTabContent(report, recommendations, notes) {
  if (state.reportTab === "holdings") return holdingsContent(report);
  if (state.reportTab === "recommendations") return recommendationsContent(report, recommendations);
  if (state.reportTab === "plan") return planContent(report, state.currentReport.models || []);
  if (state.reportTab === "notes") return notesContent(notes);
  return overviewContent(report);
}

function planContent(report, models) {
  const assumptions = report.swp?.assumptions || { principal: 5000000, monthlyWithdrawal: 50000, annualReturn: 10, years: 10 };
  return `<section class="panel"><form class="panel-body form-stack" id="planForm">
    <div>
      <p class="eyebrow">Client report section</p>
      <h3 style="margin:0;color:var(--navy)">Attach a proposed model and SWP projection</h3>
      <p class="muted small">These selections will populate the PDF and Excel report. Leave either section blank when it is not relevant.</p>
    </div>
    <label class="field"><span>Model portfolio</span><select name="modelId"><option value="">Do not attach a model</option>${models.map((model) => `<option value="${model.id}" ${Number(report.model_portfolio_id) === Number(model.id) ? "selected" : ""}>${esc(model.name)} · ${esc(model.risk_level)}</option>`).join("")}</select></label>
    <label class="checkbox"><input type="checkbox" name="includeSwp" ${report.swp ? "checked" : ""} /> Include SWP projection</label>
    <div class="form-grid">
      <label class="field"><span>Lumpsum corpus</span><input name="principal" type="number" min="0" value="${assumptions.principal}" /></label>
      <label class="field"><span>Monthly SWP</span><input name="monthlyWithdrawal" type="number" min="0" value="${assumptions.monthlyWithdrawal}" /></label>
      <label class="field"><span>Annual return %</span><input name="annualReturn" type="number" step=".1" value="${assumptions.annualReturn}" /></label>
      <label class="field"><span>Years</span><input name="years" type="number" min="1" max="40" value="${assumptions.years}" /></label>
    </div>
    ${report.swp ? `<div class="observation"><strong>Current projection</strong><span>Total withdrawn ${money.format(report.swp.rows.at(-1)?.totalWithdrawn || 0)} · ending corpus ${money.format(report.swp.rows.at(-1)?.endingCorpus || 0)}</span></div>` : ""}
    <div class="form-actions"><button class="button primary">Save proposed plan</button></div>
  </form></section>`;
}

function overviewContent(report) {
  const analytics = report.analytics;
  const allocationPanel = (title, items) => `<section class="panel"><div class="panel-header"><h3>${title}</h3></div><div class="panel-body bar-list">${items.slice(0, 8).map((item) => `<div><div class="bar-row-head"><span>${esc(item.name)}</span><strong>${item.percent.toFixed(1)}%</strong></div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, item.percent)}%"></div></div></div>`).join("") || `<span class="muted">No data</span>`}</div></section>`;
  const observations = [
    ["Category overlap", analytics.duplicateCategories.length ? `${analytics.duplicateCategories.map((x) => `${x.category} (${x.count})`).join(", ")} require rationalisation review.` : "No duplicate categories were identified."],
    ["Small holdings", analytics.smallHoldings.length ? `${analytics.smallHoldings.length} holdings fall below the configured consolidation threshold.` : "No small-value holdings were flagged."],
    ["ELSS lock-in", analytics.elss.length ? `${analytics.elss.length} ELSS holdings need transaction-level lock-in verification.` : "No ELSS exposure was identified."],
    ["Concentration", analytics.concentrated.length ? `${analytics.concentrated.length} scheme holdings exceed the configured concentration threshold.` : "No scheme-level concentration exception was identified."],
    ["Sector / thematic", analytics.thematic.length ? `${analytics.thematic.length} sector or thematic holdings require a risk and horizon note.` : "No sector/thematic schemes were identified."],
    ["Return measure", analytics.xirr == null ? "XIRR is unavailable because complete dated cash flows were not present." : `Portfolio XIRR is ${analytics.xirr.toFixed(2)}%.`],
  ];
  return `<div class="allocation-grid">
    ${allocationPanel("Asset allocation", analytics.byAssetClass)}
    ${allocationPanel("AMC allocation", analytics.byAmc)}
    ${allocationPanel("Category allocation", analytics.byCategory)}
  </div>
  <section class="panel" style="margin-top:18px"><div class="panel-header"><h3>Key observations</h3></div><div class="panel-body observation-grid">
    ${observations.map(([title, copy]) => `<div class="observation"><strong>${esc(title)}</strong><span>${esc(copy)}</span></div>`).join("")}
  </div></section>`;
}

function holdingsContent(report) {
  const returns = Object.fromEntries((report.analytics.holdingReturns || []).map((item) => [item.key, item]));
  const percent = (value) => value == null ? "—" : `${Number(value).toFixed(2)}%`;
  return `<section class="panel"><div class="panel-header"><div><h3>Portfolio holdings and investor returns</h3><span class="muted small">XIRR uses dated investor cash flows. CAGR is shown only for a single-investment holding; “—” means the CAS did not provide enough transaction history.</span></div></div><div class="table-wrap"><table><thead><tr><th>Scheme</th><th>Folio</th><th>Asset class</th><th>Category</th><th class="text-right">Allocation</th><th class="text-right">Cost</th><th class="text-right">Current value</th><th class="text-right">Gain/loss</th><th class="text-right">XIRR</th><th class="text-right">CAGR</th><th>Since</th></tr></thead><tbody>
    ${report.portfolio.holdings.map((item) => {
      const itemReturn = returns[item.key] || {};
      const allocation = report.analytics.totalValue ? (item.currentValue / report.analytics.totalValue) * 100 : 0;
      return `<tr><td><strong>${esc(item.schemeName)}</strong><br><span class="muted small">${esc(item.amc)}</span></td><td>${esc(item.folio || "—")}</td><td><span class="badge">${esc(item.assetClass)}</span></td><td>${esc(item.category)}</td><td class="text-right money">${allocation.toFixed(1)}%</td><td class="text-right money">${money.format(item.costValue)}</td><td class="text-right money"><strong>${money.format(item.currentValue)}</strong></td><td class="text-right money ${item.absoluteGain >= 0 ? "positive" : "negative"}">${money.format(item.absoluteGain)}</td><td class="text-right money">${percent(itemReturn.xirr)}</td><td class="text-right money">${percent(itemReturn.cagr)}</td><td>${itemReturn.firstInvestmentDate ? date(itemReturn.firstInvestmentDate) : "—"}</td></tr>`;
    }).join("")}
  </tbody></table></div></section>`;
}

function recommendationsContent(report, recommendations) {
  const holdingMap = Object.fromEntries(report.portfolio.holdings.map((item) => [item.key, item]));
  return `<form id="recommendationForm"><section class="panel"><div class="panel-header"><div><h3>Fund-wise recommendations</h3><span class="muted small">System suggestions are a first draft. Your final action and client note control the report.</span></div><button class="button primary" type="submit">Save recommendations</button></div>
    <div class="table-wrap"><table class="recommendation-table"><thead><tr><th>Fund</th><th>System suggestion</th><th>Reason</th><th>Final action</th><th>Client note</th><th>Internal note</th></tr></thead><tbody>
      ${recommendations.map((item) => {
        const holding = holdingMap[item.holding_key] || {};
        return `<tr data-key="${esc(item.holding_key)}"><td><strong>${esc(holding.schemeName)}</strong><br><span class="money muted">${money.format(holding.currentValue || 0)}</span></td><td><span class="badge ${item.system_action === "Hold" ? "green" : "gold"}">${esc(item.system_action)}</span></td><td class="reason">${esc(item.system_reason)}</td><td><select name="action">${state.currentReport.actions.map((action) => `<option ${action === item.final_action ? "selected" : ""}>${action}</option>`).join("")}</select></td><td><textarea name="clientNote" placeholder="Visible in client report">${esc(item.client_note || "")}</textarea></td><td><textarea name="internalNote" placeholder="Never shown unless explicitly included">${esc(item.internal_note || "")}</textarea></td></tr>`;
      }).join("")}
    </tbody></table></div></section></form>`;
}

function notesContent(notes = {}) {
  return `<section class="panel"><form class="panel-body form-stack" id="notesForm">
    <div class="form-grid">
      <label class="checkbox"><input type="checkbox" name="taxCheck" ${notes.tax_check ? "checked" : ""} /> Tax check required</label>
      <label class="checkbox"><input type="checkbox" name="exitLoadCheck" ${notes.exit_load_check ? "checked" : ""} /> Exit load check required</label>
      <label class="checkbox"><input type="checkbox" name="lockInCheck" ${notes.lock_in_check ? "checked" : ""} /> Lock-in check required</label>
      <label class="field"><span>Execution status</span><select name="executionStatus">${["Pending", "Discussed", "Approved", "Partially executed", "Completed"].map((value) => `<option ${value === notes.execution_status ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <label class="field"><span>Follow-up date</span><input name="followUpDate" type="date" value="${esc(notes.follow_up_date || "")}" /></label>
    </div>
    <label class="field"><span>Client discussion points</span><textarea name="discussionPoints" placeholder="Internal notes for the distributor or analyst">${esc(notes.discussion_points || "")}</textarea></label>
    <div class="form-actions"><button class="button primary">Save internal notes</button></div>
  </form></section>`;
}

function bindReportForms() {
  document.querySelector("#recommendationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    buttonBusy(button, true, "Saving…");
    const recommendations = [...event.currentTarget.querySelectorAll("tbody tr")].map((row) => ({
      holdingKey: row.dataset.key,
      finalAction: row.querySelector('[name="action"]').value,
      clientNote: row.querySelector('[name="clientNote"]').value,
      internalNote: row.querySelector('[name="internalNote"]').value,
    }));
    try {
      await api(`/api/reports/${state.currentReport.report.id}/recommendations`, { method: "PUT", body: JSON.stringify({ recommendations }) });
      notify("Recommendations saved.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      buttonBusy(button, false);
    }
  });
  document.querySelector("#notesForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.taxCheck = form.taxCheck.checked;
    values.exitLoadCheck = form.exitLoadCheck.checked;
    values.lockInCheck = form.lockInCheck.checked;
    try {
      await api(`/api/reports/${state.currentReport.report.id}/internal-notes`, { method: "PUT", body: JSON.stringify(values) });
      notify("Internal notes saved.");
    } catch (error) {
      notify(error.message, "error");
    }
  });
  document.querySelector("#planForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      modelId: values.modelId || null,
      swp: form.includeSwp.checked ? {
        principal: Number(values.principal),
        monthlyWithdrawal: Number(values.monthlyWithdrawal),
        annualReturn: Number(values.annualReturn),
        years: Number(values.years),
      } : null,
    };
    try {
      await api(`/api/reports/${state.currentReport.report.id}/plan`, { method: "PUT", body: JSON.stringify(payload) });
      notify("Proposed plan saved.");
      await reportPage(state.currentReport.report.id);
      state.reportTab = "plan";
      renderReport();
    } catch (error) {
      notify(error.message, "error");
    }
  });
}

async function modelsPage() {
  setActive("models", "Model Portfolios");
  const { models } = await api("/api/models");
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("Model portfolios", "Save reusable allocation frameworks for client planning.", `<button class="button primary" id="newModel">＋ Create model</button>`)}
    <section class="panel"><div class="panel-header"><h2>Saved models</h2><span class="muted small">${models.length} models</span></div>
    ${models.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Risk level</th><th>Allocation rows</th><th>Expected return</th><th>Updated</th></tr></thead><tbody>${models.map((model) => `<tr><td><strong>${esc(model.name)}</strong></td><td><span class="badge gold">${esc(model.risk_level)}</span></td><td>${model.items.length}</td><td>${esc(model.assumptions.expectedReturn || "—")}%</td><td>${date(model.updated_at)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("No model portfolios", "Create Conservative, Moderate, Aggressive, SWP-oriented or custom models.")}
    </section>
    <section class="panel hidden" id="modelEditor" style="margin-top:20px"><form class="panel-body form-stack" id="modelForm">
      <div class="form-grid">
        <label class="field"><span>Model name</span><input name="name" required placeholder="Moderate growth" /></label>
        <label class="field"><span>Risk level</span><select name="riskLevel"><option>Conservative</option><option selected>Moderate</option><option>Aggressive</option><option>Custom</option></select></label>
        <label class="field"><span>Time horizon</span><input name="timeHorizon" placeholder="7–10 years" /></label>
        <label class="field"><span>Expected return %</span><input name="expectedReturn" type="number" step=".1" value="10" /></label>
        <label class="field"><span>Lumpsum amount</span><input name="lumpsumAmount" type="number" min="0" value="0" /></label>
        <label class="field"><span>Monthly SIP amount</span><input name="sipAmount" type="number" min="0" value="0" /></label>
        <label class="field"><span>Monthly SWP amount</span><input name="swpAmount" type="number" min="0" value="0" /></label>
      </div>
      <div><div class="panel-header" style="padding-left:0;padding-right:0"><h3>Suggested allocation</h3><button class="button secondary" type="button" id="addModelItem">＋ Add row</button></div><div id="modelItems"></div></div>
      <label class="field"><span>Risk note</span><textarea name="riskNote" placeholder="Important suitability and volatility note"></textarea></label>
      <p class="form-error" id="modelError"></p>
      <div class="form-actions"><button class="button primary">Save model portfolio</button></div>
    </form></section>
  </div>`;
  state.modelItems = [{ category: "Equity", fund: "", allocation: 60, amount: 0 }];
  document.querySelector("#newModel").addEventListener("click", () => {
    document.querySelector("#modelEditor").classList.remove("hidden");
    renderModelItems();
    document.querySelector("#modelEditor").scrollIntoView({ behavior: "smooth" });
  });
  document.querySelector("#addModelItem").addEventListener("click", () => {
    state.modelItems.push({ category: "", fund: "", allocation: 0, amount: 0 });
    renderModelItems();
  });
  document.querySelector("#modelForm").addEventListener("submit", saveModel);
}

function renderModelItems() {
  const host = document.querySelector("#modelItems");
  host.innerHTML = state.modelItems.map((item, index) => `<div class="model-item" data-index="${index}">
    <label class="field"><span>Category / asset</span><input name="category" value="${esc(item.category)}" placeholder="Flexi Cap" /></label>
    <label class="field"><span>Fund (optional)</span><input name="fund" value="${esc(item.fund)}" /></label>
    <label class="field"><span>Allocation %</span><input name="allocation" type="number" min="0" max="100" step=".1" value="${item.allocation}" /></label>
    <label class="field"><span>Amount</span><input name="amount" type="number" min="0" value="${item.amount}" /></label>
    <button class="icon-button" type="button" data-remove="${index}" aria-label="Remove row">×</button>
  </div>`).join("");
  host.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    state.modelItems.splice(Number(button.dataset.remove), 1);
    renderModelItems();
  }));
}

async function saveModel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const items = [...form.querySelectorAll(".model-item")].map((row) => ({
    category: row.querySelector('[name="category"]').value,
    fund: row.querySelector('[name="fund"]').value,
    allocation: Number(row.querySelector('[name="allocation"]').value),
    amount: Number(row.querySelector('[name="amount"]').value),
  }));
  const total = items.reduce((sum, item) => sum + item.allocation, 0);
  if (Math.abs(total - 100) > 0.01) {
    document.querySelector("#modelError").textContent = `Allocation must total 100%. It currently totals ${total}%.`;
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    name: values.name,
    riskLevel: values.riskLevel,
    items,
    assumptions: {
      timeHorizon: values.timeHorizon,
      expectedReturn: Number(values.expectedReturn),
      lumpsumAmount: Number(values.lumpsumAmount),
      sipAmount: Number(values.sipAmount),
      swpAmount: Number(values.swpAmount),
      riskNote: values.riskNote,
    },
  };
  try {
    await api("/api/models", { method: "POST", body: JSON.stringify(payload) });
    notify("Model portfolio saved.");
    modelsPage();
  } catch (error) {
    document.querySelector("#modelError").textContent = error.message;
  }
}

function swpPage() {
  setActive("swp", "SWP Planner");
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("SWP & lumpsum planner", "Project yearly corpus and cumulative withdrawals using editable assumptions.")}
    <div class="dashboard-grid">
      <section class="panel"><form class="panel-body form-stack" id="swpForm">
        <label class="field"><span>Lumpsum investment</span><input name="principal" type="number" min="0" value="5000000" required /></label>
        <label class="field"><span>Monthly SWP</span><input name="monthlyWithdrawal" type="number" min="0" value="50000" required /></label>
        <label class="field"><span>Assumed annual return %</span><input name="annualReturn" type="number" step=".1" min="-20" max="30" value="10" required /></label>
        <label class="field"><span>Tenure in years</span><input name="years" type="number" min="1" max="40" value="10" required /></label>
        <button class="button primary">Calculate projection</button>
        <p class="muted small">Illustrative projection only. Returns are not guaranteed and monthly cash flow timing affects actual outcomes.</p>
      </form></section>
      <section class="panel"><div class="panel-header"><h2>How to read this</h2></div><div class="panel-body security-list">
        <li><span>₹</span><span><strong>Withdrawal timing</strong>Return is applied monthly before each withdrawal in this illustration.</span></li>
        <li><span>↗</span><span><strong>Return assumption</strong>A flat annual assumption does not model market volatility or sequence risk.</span></li>
        <li><span>⌁</span><span><strong>Execution checks</strong>Tax, exit load, scheme suitability and liquidity should be reviewed separately.</span></li>
      </div></section>
    </div>
    <div id="swpOutput" class="projection-output"></div>
  </div>`;
  document.querySelector("#swpForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api("/api/swp", { method: "POST", body: JSON.stringify(values) });
    renderProjection(result);
  });
  document.querySelector("#swpForm").requestSubmit();
}

function renderProjection(result) {
  const final = result.rows.at(-1) || {};
  document.querySelector("#swpOutput").innerHTML = `<div class="stats-grid">
    ${stat("Initial corpus", money.format(result.assumptions.principal), "₹")}
    ${stat("Monthly SWP", money.format(result.assumptions.monthlyWithdrawal), "↗")}
    ${stat("Total withdrawn", money.format(final.totalWithdrawn || 0), "↓")}
    ${stat("Ending corpus", money.format(final.endingCorpus || 0), "◈")}
  </div>
  <section class="panel"><div class="panel-header"><h2>Yearly projection</h2></div><div class="table-wrap"><table><thead><tr><th>Year</th><th class="text-right">Cumulative withdrawn</th><th class="text-right">Ending corpus</th></tr></thead><tbody>
    ${result.rows.map((row) => `<tr><td>Year ${row.year}</td><td class="text-right money">${money.format(row.totalWithdrawn)}</td><td class="text-right money"><strong>${money.format(row.endingCorpus)}</strong></td></tr>`).join("")}
  </tbody></table></div></section>`;
}

async function settingsPage() {
  setActive("settings", "Settings");
  const [{ settings }, userData, auditData] = await Promise.all([
    api("/api/settings"),
    state.user.role === "admin" ? api("/api/users") : Promise.resolve({ users: [] }),
    state.user.role === "admin" ? api("/api/audit") : Promise.resolve({ events: [] }),
  ]);
  document.querySelector("#view").innerHTML = `<div class="page">
    ${pageHeader("Settings", "Manage report branding, compliance defaults and workspace access.")}
    ${state.user.role === "admin" ? `<section class="panel"><form class="panel-body form-stack" id="settingsForm">
      <div class="form-grid">
        <label class="field"><span>Company name</span><input name="companyName" value="${esc(settings.companyName)}" /></label>
        <label class="field"><span>Address</span><input name="address" value="${esc(settings.address)}" /></label>
        <label class="field"><span>ARN</span><input name="arn" value="${esc(settings.arn)}" /></label>
        <label class="field"><span>EUIN</span><input name="euin" value="${esc(settings.euin)}" /></label>
        <label class="field"><span>Default return %</span><input name="defaultReturn" type="number" step=".1" value="${esc(settings.defaultReturn)}" /></label>
        <label class="field"><span>Small holding threshold</span><input name="smallHoldingThreshold" type="number" value="${esc(settings.smallHoldingThreshold)}" /></label>
        <label class="field"><span>Concentration threshold %</span><input name="concentrationThreshold" type="number" value="${esc(settings.concentrationThreshold)}" /></label>
        <label class="field"><span>Report footer</span><input name="reportFooter" value="${esc(settings.reportFooter)}" /></label>
      </div>
      <div class="form-grid">
        <label class="field"><span>Recommended fund list</span><textarea name="recommendedFunds" placeholder="One fund name per line">${esc((settings.recommendedFunds || []).join("\n"))}</textarea></label>
        <label class="field"><span>Categories to avoid / review</span><textarea name="categoriesToAvoid" placeholder="One category per line">${esc((settings.categoriesToAvoid || []).join("\n"))}</textarea></label>
      </div>
      <label class="field"><span>Report disclaimer</span><textarea name="disclaimer" style="min-height:150px">${esc(settings.disclaimer)}</textarea></label>
      <div class="form-actions"><button class="button primary">Save settings</button></div>
    </form></section>
    <section class="panel" style="margin-top:20px"><div class="panel-header"><h2>Company logo</h2></div><form class="panel-body form-stack" id="logoForm"><label class="field"><span>PNG, JPEG or WebP · maximum 2 MB</span><input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required /></label><div class="form-actions"><button class="button secondary">Upload logo</button></div></form></section>
    <section class="panel" style="margin-top:20px"><div class="panel-header"><h2>Staff users</h2></div><form class="panel-body form-grid" id="userForm">
      <label class="field"><span>Name</span><input name="name" required /></label>
      <label class="field"><span>Email</span><input name="email" type="email" required /></label>
      <label class="field"><span>Role</span><select name="role"><option>staff</option><option>admin</option></select></label>
      <label class="field"><span>Temporary password</span><input name="password" type="password" minlength="12" required /></label>
      <div class="form-actions"><button class="button secondary">Create user</button></div>
    </form><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${userData.users.map((user) => `<tr><td>${esc(user.name)}</td><td>${esc(user.email)}</td><td><span class="badge">${esc(user.role)}</span></td><td>${user.active ? "Active" : "Disabled"}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="panel" style="margin-top:20px"><div class="panel-header"><h2>Recent audit activity</h2></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th></tr></thead><tbody>${auditData.events.slice(0, 25).map((event) => `<tr><td>${date(event.created_at)}</td><td>${esc(event.user_name || "System")}</td><td>${esc(event.action)}</td><td>${esc(event.entity_type)} ${esc(event.entity_id || "")}</td></tr>`).join("")}</tbody></table></div></section>` : `<section class="panel"><div class="panel-body"><p>Staff accounts can view company defaults. Only an administrator can change settings or manage users.</p></div></section>`}
  </div>`;
  document.querySelector("#settingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    ["defaultReturn", "smallHoldingThreshold", "concentrationThreshold"].forEach((key) => (values[key] = Number(values[key])));
    values.recommendedFunds = values.recommendedFunds.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    values.categoriesToAvoid = values.categoriesToAvoid.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(values) });
      notify("Settings saved.");
    } catch (error) {
      notify(error.message, "error");
    }
  });
  document.querySelector("#logoForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/settings/logo", { method: "POST", body: new FormData(event.currentTarget) });
      const result = await api("/api/settings");
      state.appConfig.logoUrl = result.settings.logoUrl;
      notify("Company logo uploaded.");
      event.currentTarget.reset();
      renderShell();
      route();
    } catch (error) {
      notify(error.message, "error");
    }
  });
  document.querySelector("#userForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await api("/api/users", { method: "POST", body: JSON.stringify(values) });
      notify("Workspace user created.");
      settingsPage();
    } catch (error) {
      notify(error.message, "error");
    }
  });
}

async function route() {
  if (!state.user) return;
  const raw = location.hash.replace(/^#\//, "") || "dashboard";
  const [pathPart, query = ""] = raw.split("?");
  const parts = pathPart.split("/");
  try {
    if (parts[0] === "dashboard") return dashboardPage();
    if (parts[0] === "clients" && parts[1] === "new") return clientFormPage();
    if (parts[0] === "clients" && parts[1]) return clientDetailPage(parts[1]);
    if (parts[0] === "clients") return clientsPage();
    if (parts[0] === "upload") return uploadPage(query);
    if (parts[0] === "reports" && parts[1]) return reportPage(parts[1]);
    if (parts[0] === "models") return modelsPage();
    if (parts[0] === "swp") return swpPage();
    if (parts[0] === "settings") return settingsPage();
    location.hash = "#/dashboard";
  } catch (error) {
    notify(error.message, "error");
    document.querySelector("#view").innerHTML = `<div class="page">${emptyState("Something went wrong", error.message, `<a class="button primary" href="#/dashboard">Return to dashboard</a>`)}</div>`;
  }
}

window.addEventListener("hashchange", route);

(async function bootstrap() {
  try {
    const session = await api("/api/auth/me");
    state.user = session.user;
    state.csrf = session.csrfToken;
    state.appConfig = session.appConfig || state.appConfig;
    if (!location.hash) location.hash = "#/dashboard";
    renderShell();
    route();
  } catch {
    renderLogin();
  }
})();
