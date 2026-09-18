const $ = (selector, root = document) => root.querySelector(selector);
const state = {
  overview: null,
  runs: [],
  details: new Map(),
  errors: new Map(),
  loading: new Set(),
  selected: null,
  detailTab: "outcomes",
  search: "",
  filter: "all",
  compareSelected: "",
  compareReference: "all",
  formMode: "new",
  harness: null,
  skillEdits: new Map(),
  skillPath: "",
  refreshing: false,
  pendingTrigger: null,
  pendingJobId: null,
  jobs: [],
  openPanels: new Set(),
  reviewPrStates: new Map(),
};
const html = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const number = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
    : "Unknown";
const compact = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value)
    : "—";
const money = (value) =>
  Number.isFinite(value) ? `$${value.toFixed(value < 1 ? 4 : 2)}` : "Unknown";
const percent = (value) =>
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.href
      : "#";
  } catch {
    return "#";
  }
};
const empty = (title, description, icon = "◫") =>
  `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${icon}</span><h3>${html(title)}</h3><p>${html(description)}</p></div>`;
const completed = (run) => run.status === "completed";
const detailTabs = ["outcomes", "tasks", "changes", "usage", "configuration"];
const reportOf = (id) => state.details.get(Number(id))?.report;
const releaseRows = (report, release = "candidate") =>
  report?.runs?.filter((row) => row.slot.release_id === release) ?? [];
const validOutcomes = new Set([
  "PASS",
  "FUNCTIONAL_FAIL",
  "REGRESSION_FAIL",
  "POLICY_VIOLATION",
  "AGENT_TIMEOUT",
  "CANDIDATE_CONFIG_ERROR",
]);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  const value = await response
    .json()
    .catch(() => ({ error: `Server returned ${response.status}` }));
  if (!response.ok)
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : (value.error?.message ??
            value.message ??
            `Request failed (${response.status})`),
    );
  return value;
}
function message(text, kind = "") {
  $("#global-message").innerHTML = text
    ? `<div class="notice ${html(kind)}">${html(text)}</div>`
    : "";
}
let toastTimer;
function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 6500);
}
function runLabel(run) {
  const report = reportOf(run.id),
    model = report?.configuration_change?.candidate?.model;
  return `${friendlyName(run) ?? model ?? "Evaluation"} · #${run.id}`;
}
function friendlyName(run) {
  return typeof run.name === "string" &&
    !run.name.startsWith("Fullbeam compare ")
    ? run.name
    : null;
}
function status(run, report = reportOf(run.id)) {
  if (!completed(run))
    return {
      label: run.status === "queued" ? "Queued" : "Running",
      tone: "active",
    };
  if (run.conclusion === "cancelled")
    return { label: "Cancelled", tone: "neutral" };
  if (
    report?.runs?.some((row) => row.run.outcome === "INFRA_ERROR") ||
    report?.summary?.execution_completeness === "INCOMPLETE"
  )
    return { label: "Incomplete", tone: "warning" };
  if (report?.runs?.some((row) => row.run.outcome === "POLICY_VIOLATION"))
    return { label: "Policy violations", tone: "failed" };
  if (run.conclusion !== "success")
    return {
      label:
        run.conclusion === "failure"
          ? "Workflow failed"
          : (run.conclusion ?? "Unknown"),
      tone: "failed",
    };
  return { label: "Completed", tone: "success" };
}
const badge = (value) =>
  `<span class="status-badge status-${html(value.tone)}">${html(value.label)}</span>`;
function outcomeBadge(outcome) {
  return badge({
    label:
      {
        PASS: "Pass",
        FUNCTIONAL_FAIL: "Functional fail",
        REGRESSION_FAIL: "Regression",
        POLICY_VIOLATION: "Policy violation",
        AGENT_TIMEOUT: "Agent timeout",
        CANDIDATE_CONFIG_ERROR: "Config error",
        INFRA_ERROR: "Infrastructure error",
        CANCELLED: "Cancelled",
      }[outcome] ?? outcome,
    tone:
      outcome === "PASS"
        ? "success"
        : ["INFRA_ERROR", "CANCELLED"].includes(outcome)
          ? "warning"
          : "failed",
  });
}
function metrics(detail, release = null, taskIds = null) {
  const rows =
    (
      detail?.report?.runs ??
      detail?.attempts?.map((attempt) => ({
        slot: { release_id: attempt.release, task_id: attempt.taskId },
        run: { outcome: attempt.outcome },
      }))
    )?.filter(
      (row) =>
        (!release || row.slot.release_id === release) &&
        (!taskIds || taskIds.has(row.slot.task_id)),
    ) ?? [];
  const attempts = (detail?.attempts ?? []).filter(
    (row) =>
      (!release || row.release === release) &&
      (!taskIds || taskIds.has(row.taskId)),
  );
  const result = {
    attempts: rows.length,
    passes: rows.filter((row) => row.run.outcome === "PASS").length,
    valid: rows.filter((row) => validOutcomes.has(row.run.outcome)).length,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    tokenCoverage: 0,
    completeTokenCoverage: 0,
    cachedCoverage: 0,
    cost: 0,
    inputCost: 0,
    cachedCost: 0,
    outputCost: 0,
    costCoverage: 0,
  };
  for (const attempt of attempts) {
    if (
      attempt.usage &&
      Number.isFinite(attempt.usage.inputTokens) &&
      Number.isFinite(attempt.usage.outputTokens)
    ) {
      result.input += attempt.usage.inputTokens;
      result.output += attempt.usage.outputTokens;
      result.reasoning += attempt.usage.reasoningTokens ?? 0;
      result.tokenCoverage++;
      const cachedKnown =
        Number.isFinite(attempt.usage.cachedInputTokens) &&
        attempt.usage.cachedInputTokens >= 0 &&
        attempt.usage.cachedInputTokens <= attempt.usage.inputTokens;
      if (cachedKnown) {
        result.cached += attempt.usage.cachedInputTokens;
        result.cachedCoverage++;
      }
      if (attempt.usage.complete === true && cachedKnown)
        result.completeTokenCoverage++;
    }
    if (attempt.cost && Number.isFinite(attempt.cost.totalUsd)) {
      result.cost += attempt.cost.totalUsd;
      result.inputCost += attempt.cost.uncachedInputUsd ?? 0;
      result.cachedCost += attempt.cost.cachedInputUsd ?? 0;
      result.outputCost += attempt.cost.outputUsd ?? 0;
      result.costCoverage++;
    }
  }
  result.tokens = result.input + result.output;
  result.passRate = result.attempts ? result.passes / result.attempts : null;
  result.completeCost =
    result.attempts > 0 && result.costCoverage === result.attempts;
  result.completeTokens =
    result.attempts > 0 && result.completeTokenCoverage === result.attempts;
  return result;
}
function aggregate(details, release = null, taskIds = null) {
  const total = {
    attempts: 0,
    passes: 0,
    valid: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    tokens: 0,
    tokenCoverage: 0,
    completeTokenCoverage: 0,
    cachedCoverage: 0,
    cost: 0,
    inputCost: 0,
    cachedCost: 0,
    outputCost: 0,
    costCoverage: 0,
  };
  for (const detail of details) {
    const value = metrics(detail, release, taskIds);
    for (const key of Object.keys(total)) total[key] += value[key] ?? 0;
  }
  total.passRate = total.attempts ? total.passes / total.attempts : null;
  total.completeCost =
    total.attempts > 0 && total.costCoverage === total.attempts;
  total.completeTokens =
    total.attempts > 0 && total.completeTokenCoverage === total.attempts;
  return total;
}
const costValue = (value) =>
  value.costCoverage
    ? `${money(value.cost)}${value.completeCost ? "" : "*"}`
    : "Unknown";
const tokenValue = (value, key = "tokens", format = number) =>
  (key === "cached" ? value.cachedCoverage : value.tokenCoverage)
    ? `${format(value[key])}${value.completeTokens ? "" : "*"}`
    : "Unknown";
const tokenCoverageNote = (value) =>
  `${value.completeTokenCoverage}/${value.attempts} complete · ${value.tokenCoverage}/${value.attempts} observed`;
function metricCard(label, value, note, icon) {
  return `<article class="metric-card"><div class="metric-label">${html(label)}</div><div class="metric-icon" aria-hidden="true">${icon}</div><div class="metric-value">${html(value)}</div><p class="metric-note">${html(note)}</p></article>`;
}

function renderOverview() {
  const details = [...state.details.values()].filter((detail) => detail.report),
    totals = aggregate(details);
  const active = state.runs.filter((run) => !completed(run)).length;
  $("#nav-count").textContent = state.runs.length;
  $("#history-count").textContent = state.runs.length;
  $("#scope-note").textContent =
    `${details.length} recorded reports loaded · ${state.runs.length} workflow runs${active ? ` · ${active} active` : ""}. Usage and cost cover loaded reports only. * Marks an observed subtotal with incomplete coverage.`;
  const persistence = state.overview?.persistence;
  $("#infrastructure-status").innerHTML =
    `<span class="infrastructure-item"><span aria-hidden="true">◇</span> Execution: <strong>InstaCloud VMs</strong></span><span class="infrastructure-item">${persistence?.provider === "instacloud-postgres" && persistence.status === "connected" ? `<span class="status-dot"></span><strong>InstaCloud Postgres</strong><span>${persistence.history === "persisted" && persistence.queue === "persisted" ? "History & queue persisted" : "Connected"}</span>` : `<span aria-hidden="true">◌</span><span>Database status not available</span>`}</span>`;
  $("#metrics").innerHTML = [
    metricCard(
      "EVALUATION RUNS",
      number(state.runs.length),
      `${active} running · ${details.length} reports available`,
      "◫",
    ),
    metricCard(
      "VERIFIED PASS RATE",
      percent(totals.passRate),
      `${totals.passes} passes / ${totals.attempts} observed attempts`,
      "↗",
    ),
    metricCard(
      "MODEL COST ESTIMATE",
      costValue(totals),
      `${totals.costCoverage}/${totals.attempts} attempts priced${totals.completeCost ? " · USD" : " · subtotal when partial"}`,
      "$",
    ),
    metricCard(
      "TOTAL TOKENS",
      tokenValue(totals, "tokens", compact),
      `${tokenValue(totals, "input", compact)} input · ${tokenValue(totals, "output", compact)} output · ${totals.completeTokenCoverage}/${totals.attempts} complete`,
      "≋",
    ),
  ].join("");
  renderHistoryChart();
  renderUsageChart(totals);
  renderModelSummary();
  renderRuns();
  renderCompareOptions();
  renderJobs();
}
function renderModelSummary() {
  const groups = new Map();
  for (const detail of state.details.values()) {
    const attempts = (detail.attempts ?? []).filter(
      (attempt) => attempt.release === "candidate",
    );
    for (const model of new Set(
      attempts.map((attempt) => attempt.model).filter(Boolean),
    )) {
      const subset = attempts.filter((attempt) => attempt.model === model);
      const scoped = {
        ...detail,
        hasFinalReport: Boolean(detail.report),
        report: null,
        attempts: subset,
      };
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model).push(scoped);
    }
  }
  $("#model-table").innerHTML = groups.size
    ? [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, details]) => {
          const value = aggregate(details, "candidate");
          const live = details.some((detail) => !completed(detail.run));
          const partial =
            details.some((detail) => !detail.hasFinalReport) ||
            value.valid < value.attempts;
          return `<tr><td><div class="run-name">${html(model)}</div><div class="run-subtitle">${details.length} evaluation${details.length === 1 ? "" : "s"} with observations</div>${live ? badge({ label: "Includes live observations", tone: "active" }) : partial ? badge({ label: "Includes partial evidence", tone: "warning" }) : ""}</td><td>${value.passes}/${value.attempts} observed<div class="run-subtitle">${percent(value.passRate)} observed pass rate</div><div class="run-subtitle">${value.valid} valid · ${value.attempts - value.valid} invalid / cancelled</div></td><td>${tokenValue(value, "input")}<div class="run-subtitle">${tokenValue(value, "cached")} cached</div></td><td>${tokenValue(value, "output")}<div class="run-subtitle">${tokenCoverageNote(value)}</div></td><td>${value.costCoverage ? money(value.inputCost + value.cachedCost) : "Unknown"}</td><td>${value.costCoverage ? money(value.outputCost) : "Unknown"}</td><td>${costValue(value)}<div class="run-subtitle">${value.costCoverage}/${value.attempts} priced</div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7">${empty("Model comparisons start with observed attempts", "Model rows appear as real execution checkpoints or completed reports become available.", "⇄")}</td></tr>`;
}
function renderJobs() {
  const visible = state.jobs
    .filter((job) => job.status !== "completed")
    .slice(0, 6);
  $("#queued-jobs").innerHTML = visible
    .map((job) => {
      const failed = ["failed", "dispatch_unknown"].includes(job.status);
      const label =
        {
          queued: "Queued",
          preparing: "Preparing harness",
          dispatching: "Starting workflow",
          running: "Running",
          failed: "Could not start",
          dispatch_unknown: "Dispatch requires review",
        }[job.status] ?? job.status;
      return `<div class="notice ${failed ? "error" : ""}"><strong>${html(job.name ?? job.jobId)}</strong> · ${html(label)}${job.status === "queued" ? " — waiting for the current evaluation to finish. Your request is saved." : ""}${job.error ? `<br>${html(job.error)}` : ""}${job.runId ? ` <a class="text-button" href="${html(safeUrl(job.url))}" target="_blank" rel="noopener noreferrer">Run #${job.runId} ↗</a>` : ""}</div>`;
    })
    .join("");
}
function renderHistoryChart() {
  const points = state.runs
    .filter((run) => reportOf(run.id))
    .slice(0, 12)
    .reverse()
    .map((run) => ({
      run,
      metric: metrics(state.details.get(run.id), "candidate"),
    }));
  if (!points.length) {
    $("#history-chart").innerHTML = empty(
      "Your first evidence trail starts here",
      "Completed reports will appear here. No sample results are shown.",
      "↗",
    );
    return;
  }
  const width = 540,
    height = 196,
    left = 38,
    right = 18,
    top = 19,
    bottom = 37;
  const plotW = width - left - right,
    plotH = height - top - bottom;
  const xy = points.map((point, index) => ({
    ...point,
    x:
      left +
      (points.length === 1 ? plotW / 2 : (index * plotW) / (points.length - 1)),
    y: top + plotH * (1 - (point.metric.passRate ?? 0)),
  }));
  const path = xy
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
  $("#history-chart").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Candidate pass rates for ${points.length} recorded evaluations"><defs><linearGradient id="history-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9178ed" stop-opacity=".18"/><stop offset="100%" stop-color="#9178ed" stop-opacity=".01"/></linearGradient></defs>${[0, 0.25, 0.5, 0.75, 1].map((value) => `<line class="chart-gridline" x1="${left}" y1="${top + plotH * (1 - value)}" x2="${width - right}" y2="${top + plotH * (1 - value)}"/><text class="chart-label" x="0" y="${top + plotH * (1 - value) + 3}">${value * 100}%</text>`).join("")}<path d="${path} L${xy.at(-1).x},${top + plotH} L${xy[0].x},${top + plotH} Z" fill="url(#history-area)"/><path d="${path}" stroke="#8a6ee9" stroke-width="2.5" fill="none" stroke-linejoin="round"/>${xy.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="4.2" fill="#fff" stroke="#8a6ee9" stroke-width="2"><title>Run ${point.run.id}: ${point.metric.passes}/${point.metric.attempts} candidate passes${point.metric.valid < point.metric.attempts ? " (incomplete evidence)" : ""}</title></circle>${points.length < 7 || index % Math.ceil(points.length / 6) === 0 || index === points.length - 1 ? `<text class="chart-label" x="${point.x}" y="${height - 10}" text-anchor="middle">#${String(point.run.id).slice(-5)}</text>` : ""}`).join("")}</svg>`;
}
function renderUsageChart(value) {
  if (!value.tokenCoverage) {
    $("#usage-chart").innerHTML = empty(
      "Usage appears with real traces",
      "Input, cached input, and output tokens are recorded when provider usage is available.",
      "≋",
    );
    return;
  }
  const splitKnown = value.cachedCoverage === value.tokenCoverage;
  const rows = [
      {
        label: splitKnown ? "Input · uncached" : "Input · total",
        value: splitKnown
          ? Math.max(0, value.input - value.cached)
          : value.input,
        color: "#8870e6",
      },
      {
        label: "Input · cached",
        value: value.cachedCoverage ? value.cached : null,
        color: "#79bdae",
      },
      { label: "Output", value: value.output, color: "#e9bb77" },
    ],
    maximum = Math.max(...rows.map((row) => row.value), 1);
  $("#usage-chart").innerHTML =
    `<svg viewBox="0 0 385 184" role="img" aria-label="Observed token usage: ${rows.map((row) => `${row.label}: ${number(row.value)}`).join(", ")}">${rows.map((row, index) => `<text class="chart-bar-label" x="8" y="${index * 51 + 21}">${row.label}</text><text class="chart-bar-label" x="376" y="${index * 51 + 21}" text-anchor="end">${number(row.value)}${row.value !== null && !value.completeTokens ? "*" : ""}</text><rect x="8" y="${index * 51 + 31}" width="368" height="12" rx="4" fill="#f2f1f7"/>${row.value === null ? "" : `<rect x="8" y="${index * 51 + 31}" width="${(368 * row.value) / maximum}" height="12" rx="4" fill="${row.color}"/>`}`).join("")}<text class="chart-label" x="8" y="180">${tokenCoverageNote(value)}${value.completeTokens ? "" : " · * observed subtotal"}</text></svg>`;
}
function renderRuns() {
  const rows = state.runs.filter((run) => {
    const report = reportOf(run.id),
      label = status(run, report);
    const search =
      `${run.id} ${run.name ?? ""} ${report?.configuration_change?.candidate?.model ?? ""} ${label.label}`.toLowerCase();
    return (
      search.includes(state.search.toLowerCase()) &&
      (state.filter === "all" ||
        (state.filter === "active" && !completed(run)) ||
        (state.filter === "complete" && completed(run)) ||
        (state.filter === "failed" &&
          ["failed", "warning"].includes(label.tone)))
    );
  });
  $("#run-table").innerHTML = rows.length
    ? rows
        .map((run) => {
          const detail = state.details.get(run.id),
            report = detail?.report,
            value = metrics(detail),
            candidates = releaseRows(report);
          const model = report?.configuration_change?.candidate;
          return `<tr class="run-row${state.selected === run.id ? " selected" : ""}" data-run-id="${run.id}" tabindex="0" aria-label="Open evaluation ${run.id}"><td><div class="run-name">${html(friendlyName(run) ?? "Evaluation")}</div><div class="run-subtitle"><span class="run-number">#${run.id}</span> · ${html(report?.configuration_change?.classification?.replaceAll("_", " ") ?? (!completed(run) ? "Fresh environments · live workflow" : state.errors.has(run.id) ? "Report unavailable" : "Workflow execution"))}</div></td><td><div class="run-name">${html(model?.model ?? "—")}</div><div class="run-subtitle">${html(model ? `${model.reasoning_effort ?? "default"} reasoning` : state.loading.has(run.id) ? "Loading report…" : "Awaiting recorded settings")}</div></td><td>${badge(status(run, report))}</td><td>${report ? `${candidates.filter((row) => row.run.outcome === "PASS").length}<span class="run-subtitle"> / ${candidates.length} passed</span><div class="result-track" aria-hidden="true">${candidates.map((row) => `<span class="result-block ${row.run.outcome === "PASS" ? "pass" : validOutcomes.has(row.run.outcome) ? "fail" : "invalid"}"></span>`).join("")}</div>` : "—"}</td><td>${html(report ? costValue(value) : "—")}${report ? `<div class="run-subtitle">${value.costCoverage}/${value.attempts} priced</div>` : ""}</td><td>${html(date(run.createdAt))}</td><td><span aria-hidden="true">↗</span></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7">${empty(state.runs.length ? "No matching runs" : "No evaluations yet", state.runs.length ? "Try a different search or status filter." : "Start an evaluation to build your private comparison history.")}</td></tr>`;
  const missing = state.runs.filter(
    (run) => completed(run) && !state.details.has(run.id),
  ).length;
  $("#history-footer").innerHTML =
    `<span>${rows.length} of ${state.runs.length} real runs${state.loading.size ? ` · Loading ${state.loading.size} reports…` : ""}</span>${missing ? `<button id="load-all" type="button">Load all ${missing} remaining reports →</button>` : `<span>Cost is unknown when no verified rate is available.</span>`}`;
}
function renderCompareOptions() {
  const eligible = state.runs.filter((run) => reportOf(run.id));
  if (!state.compareSelected && eligible.length)
    state.compareSelected = String(eligible[0].id);
  const options = eligible
    .map((run) => `<option value="${run.id}">${html(runLabel(run))}</option>`)
    .join("");
  $("#compare-selected").innerHTML =
    `<option value="">Select a recorded report</option>${options}`;
  $("#compare-selected").value = state.compareSelected;
  $("#compare-reference").innerHTML =
    `<option value="all">All other historical reports</option>${options}`;
  $("#compare-reference").value = state.compareReference;
}
async function loadDetail(id, force = false) {
  id = Number(id);
  if (state.loading.has(id) || (!force && state.details.get(id)?.report))
    return;
  state.loading.add(id);
  renderRuns();
  try {
    const detail = await api(`/api/runs/${id}`);
    state.details.set(id, detail);
    state.errors.delete(id);
    if (detail.artifactError) state.errors.set(id, detail.artifactError);
  } catch (error) {
    state.errors.set(id, error.message);
  } finally {
    state.loading.delete(id);
    renderOverview();
    if (state.selected === id) renderDetail();
  }
}
async function loadReports(runs) {
  const queue = runs.slice();
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) await loadDetail(queue.shift().id);
    }),
  );
}
async function refresh(initial = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  $("#refresh").disabled = true;
  try {
    if (initial || !state.overview) {
      state.overview = await api("/api/overview");
      state.runs = state.overview.runs ?? [];
      $("#connection").innerHTML =
        `<span class="status-dot"></span> ${html(state.overview.repository)}`;
      $("#repository-link").href = safeUrl(
        `https://github.com/${state.overview.repository}`,
      );
      populateModels();
    } else {
      const value = await api("/api/runs");
      state.runs = value.runs ?? [];
    }
    try {
      state.jobs = (await api("/api/jobs")).jobs ?? [];
    } catch {
      /* Older local controllers have no queue endpoint. */
    }
    state.runs.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    renderOverview();
    if (state.pendingJobId) {
      const job = state.jobs.find((job) => job.jobId === state.pendingJobId);
      if (job?.runId && state.runs.some((run) => run.id === job.runId)) {
        state.selected = job.runId;
        state.pendingJobId = null;
        renderDetail();
        message(
          `Evaluation #${job.runId} is now available in your run history.`,
          "success",
        );
        toast(`Your queued evaluation is now run #${job.runId}.`);
      }
    }
    if (state.pendingTrigger) {
      const matched = state.runs.find(
        (run) =>
          run.trigger === state.pendingTrigger ||
          run.name?.includes(state.pendingTrigger),
      );
      if (matched) {
        state.pendingTrigger = null;
        state.selected = matched.id;
        renderDetail();
        toast(`Evaluation #${matched.id} is running.`);
      }
    }
    const recent = state.runs
      .filter(completed)
      .slice(0, 8)
      .filter((run) => !state.details.get(run.id)?.report);
    if (state.selected && !recent.some((run) => run.id === state.selected)) {
      const selected = state.runs.find((run) => run.id === state.selected);
      if (
        selected &&
        (completed(selected) || !state.details.get(selected.id)?.report)
      )
        recent.unshift(selected);
    }
    await loadReports(recent);
    if (state.selected) renderDetail();
  } catch (error) {
    message(error.message, "error");
    $("#connection").textContent = "Connection unavailable";
  } finally {
    state.refreshing = false;
    $("#refresh").disabled = false;
  }
}
function renderDetail() {
  const section = $("#run-detail"),
    run = state.runs.find((row) => row.id === state.selected);
  if (!run) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const detail = state.details.get(run.id),
    report = detail?.report;
  const tabs = detailTabs;
  section.innerHTML = `<div class="card"><div class="detail-heading"><div><div class="eyebrow">EVALUATION DETAIL</div><h2 id="detail-title">Run #${run.id} ${badge(status(run, report))}</h2><p>${html(date(run.createdAt))}${report ? ` · PR #${report.comparison.candidate_pr} · <span class="mono">${html(report.comparison.candidate_head_sha.slice(0, 12))}</span>` : ""}</p></div><div class="actions"><a class="button button-secondary small" href="${html(safeUrl(run.url))}" target="_blank" rel="noopener noreferrer">GitHub Actions ↗</a><button class="close-detail" id="close-detail" type="button" aria-label="Close run detail">×</button></div></div>${report || detail?.progress ? `<div class="detail-tabs" role="tablist" aria-label="Run detail">${tabs.map((tab) => `<button type="button" role="tab" aria-selected="${state.detailTab === tab}" tabindex="${state.detailTab === tab ? 0 : -1}" class="${state.detailTab === tab ? "active" : ""}" data-detail-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}</div><div class="detail-content">${renderDetailContent(detail)}</div>` : `<div class="detail-content">${renderProgress(detail, run)}</div>`}</div>`;
}
function renderProgress(detail, run) {
  const progress = detail?.progress;
  if (!progress)
    return empty(
      !completed(run)
        ? "Evaluation in progress"
        : state.loading.has(run.id)
          ? "Reading recorded evidence"
          : "No completed report available",
      !completed(run)
        ? "Fresh generation and verification environments are running in GitHub Actions. Recorded checkpoints appear here as they finish."
        : (state.errors.get(run.id) ??
            "This workflow has not published a completed comparison report."),
      !completed(run) ? "◌" : "◫",
    );
  const totals = metrics(detail),
    attempts = detail.attempts ?? [];
  return `<div class="note-box">${completed(run) ? "No final comparison report was published. These are the retained observations from this workflow." : "Live checkpoint evidence. This evaluation is still running; these partial observations are not a final result."}</div><div class="live-progress"><label for="attempt-progress">${progress.observedAttempts}/${progress.plannedAttempts} attempts recorded</label><progress id="attempt-progress" value="${progress.observedAttempts}" max="${progress.plannedAttempts}">${progress.observedAttempts}/${progress.plannedAttempts}</progress></div><div class="detail-metrics"><div class="detail-metric"><span>Observed passes</span><strong>${totals.passes}<span> / ${totals.attempts}</span></strong><span>Recorded attempts only</span></div><div class="detail-metric"><span>Model cost estimate so far</span><strong>${costValue(totals)}</strong><span>${totals.costCoverage}/${totals.attempts} recorded attempts priced</span></div><div class="detail-metric"><span>Input tokens so far</span><strong>${tokenValue(totals, "input", compact)}</strong><span>${tokenValue(totals, "cached", compact)} cached</span></div><div class="detail-metric"><span>Output tokens so far</span><strong>${tokenValue(totals, "output", compact)}</strong><span>${tokenCoverageNote(totals)}</span></div></div>${detail.artifactError ? `<div class="notice error">${html(detail.artifactError)}</div>` : ""}${attempts.length ? `<div class="table-scroll"><table><thead><tr><th>Task</th><th>Configuration</th><th>Model</th><th>Outcome</th><th>Checks</th></tr></thead><tbody>${attempts.map((attempt) => `<tr><td>${html(attempt.taskId)}<div class="run-subtitle">Attempt ${attempt.repeat}/2</div></td><td>${html(attempt.release)}</td><td>${html(attempt.model ?? "Unknown")}</td><td>${outcomeBadge(attempt.outcome)}</td><td>${(attempt.checks ?? []).filter((check) => check.outcome === "PASS").length}/${attempt.checks?.length ?? 0}</td></tr>`).join("")}</tbody></table></div>` : `<p class="comparison-note">The immutable schedule is recorded. Waiting for the first attempt checkpoints.</p>`}`;
}
function renderDetailContent(detail) {
  const { report } = detail,
    totals = metrics(detail);
  if (state.detailTab === "tasks") return renderTasks(detail);
  if (state.detailTab === "changes") return renderChanges(detail);
  if (state.detailTab === "configuration") return renderConfiguration(detail);
  if (state.detailTab === "outcomes" && !report)
    return renderProgress(
      detail,
      state.runs.find((run) => run.id === state.selected),
    );
  if (state.detailTab === "usage") {
    return `<div class="detail-metrics"><div class="detail-metric"><span>Model cost estimate</span><strong>${costValue(totals)}</strong><span>${totals.costCoverage}/${totals.attempts} attempts priced</span></div><div class="detail-metric"><span>Input tokens (total)</span><strong>${tokenValue(totals, "input")}</strong><span>Includes cached input</span></div><div class="detail-metric"><span>Cached input tokens</span><strong>${tokenValue(totals, "cached")}</strong><span>A subset of input · ${totals.cachedCoverage}/${totals.attempts} observed</span></div><div class="detail-metric"><span>Output tokens</span><strong>${tokenValue(totals, "output")}</strong><span>${tokenCoverageNote(totals)}</span></div></div><div class="split-columns"><div class="config-block"><h3>Estimated cost breakdown · USD</h3><div class="cost-list"><div><span>Uncached input</span><strong>${totals.costCoverage ? money(totals.inputCost) : "Unknown"}</strong></div><div><span>Cached input</span><strong>${totals.costCoverage ? money(totals.cachedCost) : "Unknown"}</strong></div><div><span>Output</span><strong>${totals.costCoverage ? money(totals.outputCost) : "Unknown"}</strong></div><div><span>Estimated ${totals.completeCost ? "total" : "subtotal"}</span><strong>${costValue(totals)}</strong></div></div></div><div class="config-block"><h3>Coverage & attribution</h3><p class="comparison-note">Estimates use observed provider usage and recorded rates, or current verified catalog rates when historical rates are missing. These are not invoices. A missing price remains unknown. An asterisk marks an observed subtotal with incomplete coverage. Cached input is included once; reasoning tokens, where reported, are already included in output.</p><div class="key-value"><span>InstaCloud execution cost</span><strong>Unknown</strong></div><div class="key-value"><span>Usage coverage</span><strong>${tokenCoverageNote(totals)}</strong></div></div></div>`;
  }
  const current = metrics(detail, "current"),
    candidate = metrics(detail, "candidate");
  const outcomeRows = report.runs
    .map(
      ({ slot, run }) =>
        `<tr><td><div class="run-name">${html(slot.task_id)}</div><div class="run-subtitle">Attempt ${slot.repeat}/2</div></td><td>${html(slot.release_id)}</td><td>${outcomeBadge(run.outcome)}</td><td>${run.checks.filter((check) => check.outcome === "PASS").length}/${run.checks.length} checks</td><td class="reason-cell">${html(run.reason)}</td></tr>`,
    )
    .join("");
  return `<div class="detail-metrics"><div class="detail-metric"><span>Current passes</span><strong>${current.passes}<span> / ${current.attempts}</span></strong><span>${html(report.configuration_change?.current?.model ?? "Unknown model")}</span></div><div class="detail-metric"><span>Candidate passes</span><strong>${candidate.passes}<span> / ${candidate.attempts}</span></strong><span>${html(report.configuration_change?.candidate?.model ?? "Unknown model")}</span></div><div class="detail-metric"><span>Independent tasks</span><strong>${report.summary.distinct_tasks}</strong><span>Two attempts per configuration</span></div><div class="detail-metric"><span>Cleanup</span><strong>${report.cleanup_status === "CONFIRMED" ? "Confirmed" : html(report.cleanup_status)}</strong><span>Fresh generation + verification</span></div></div>${report.runs.some((row) => row.run.outcome === "POLICY_VIOLATION") ? `<div class="notice error">Policy violations are observed failures. Protected file edits were rejected and those attempts were not independently verified.</div>` : ""}${report.summary.execution_completeness !== "COMPLETE" ? `<div class="notice error">This comparison is incomplete. Infrastructure errors and missing observations remain visible; they are not counted as verified passes.</div>` : ""}<div class="table-scroll"><table><thead><tr><th>Task</th><th>Configuration</th><th>Outcome</th><th>Verification</th><th>Evidence</th></tr></thead><tbody>${outcomeRows}</tbody></table></div><p class="comparison-note">${html(report.summary.advisory?.replaceAll("_", " "))} · ${html(report.summary.release_decision?.replaceAll("_", " "))}</p>`;
}
function evidenceLink(url, label) {
  return `<a class="text-button" href="${html(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${html(label)} ↗</a>`;
}
function commitLink(sha, label = null) {
  return sha
    ? evidenceLink(
        `https://github.com/${state.overview.repository}/commit/${sha}`,
        label ?? sha.slice(0, 12),
      )
    : "Unknown";
}
function disclosure(key, summary, content, className = "evidence-disclosure") {
  const identity = `${state.selected}/${key}`;
  return `<details class="${className}" data-disclosure="${html(identity)}"${state.openPanels.has(identity) ? " open" : ""}><summary>${summary}</summary>${content}</details>`;
}
function renderTasks(detail) {
  const tasks = detail.tasks ?? [];
  if (!tasks.length)
    return empty(
      "Frozen task definitions are unavailable",
      "Task prompts and check expectations will appear when the controller can read this run’s frozen benchmark. No task content is inferred.",
      "☷",
    );
  return `<div class="note-box">These are the frozen task prompts and verification expectations used for this evaluation. Historical fixes are benchmark provenance; generated attempts appear in Changes.</div><div class="task-cards">${tasks.map((task) => `<article class="task-card"><div class="task-heading"><div><div class="eyebrow">${html(task.id)}</div><h3>${html(task.title)}</h3></div><div class="task-links">${task.issueUrl ? evidenceLink(task.issueUrl, "Source issue") : ""}${task.referencePrUrl ? evidenceLink(task.referencePrUrl, "Historical fix PR") : ""}</div></div><div class="task-metadata"><span>Source ${commitLink(task.sourceCommit)}</span><span>Writes: <code>${html((task.allowedWritePaths ?? []).join(", ") || "Not recorded")}</code></span></div>${disclosure(`task-prompt-${task.id}`, "Frozen task prompt", `<pre class="evidence-text">${html(task.prompt ?? "Prompt not recorded")}</pre>`)}<div class="split-columns check-groups"><div><h4>Preserve existing behavior</h4><p>PASS_TO_PASS expectations</p><ul>${(task.passToPassCheckIds ?? []).map((id) => `<li><code>${html(id)}</code></li>`).join("")}</ul></div><div><h4>Fix the reported behavior</h4><p>FAIL_TO_PASS expectations</p><ul>${(task.failToPassCheckIds ?? []).map((id) => `<li><code>${html(id)}</code></li>`).join("")}</ul></div></div></article>`).join("")}</div>`;
}
function renderConfiguration(detail) {
  const report = detail.report,
    config = detail.configuration ?? {};
  const comparison = report?.comparison ?? detail.comparison ?? {};
  const change = report?.configuration_change ?? detail.configurationChange;
  const candidatePr =
    config.candidatePr ??
    (comparison.candidate_pr
      ? {
          number: comparison.candidate_pr,
          url: `https://github.com/${state.overview.repository}/pull/${comparison.candidate_pr}`,
        }
      : null);
  const header = `<div class="configuration-links">${candidatePr ? evidenceLink(candidatePr.url, `Harness configuration PR #${candidatePr.number}`) : ""}${commitLink(config.controllerCommit ?? comparison.controller_commit_sha, "Frozen controller")}${commitLink(config.benchmarkCommit ?? comparison.benchmark_source_sha, "Frozen benchmark")}</div>`;
  return `${header}<div class="note-box">${html(change?.classification ?? "Classification pending final report")} · ${change?.classification === "BUNDLE" ? "Model settings and harness content changed together. The result cannot isolate either change’s effect." : "These native files and settings are frozen for the agents. Generated task edits are captured separately in Changes."}</div><div class="split-columns">${[
    "current",
    "candidate",
  ]
    .map((side) => {
      const harness = detail.harnesses?.[side],
        settings = harness?.settings ?? {};
      const value = change?.[side] ?? {
        model: settings.model,
        reasoning_effort: settings.model_reasoning_effort,
      };
      const commit =
        harness?.sourceCommit ??
        (side === "current"
          ? (config.baselineCommit ?? comparison.baseline_source_sha)
          : (config.candidateCommit ?? comparison.candidate_head_sha));
      return `<div class="config-block"><h3>${side === "current" ? "Current configuration" : "Candidate configuration"}</h3><div class="key-value"><span>Model</span><strong>${html(value.model ?? "Unknown")}</strong></div><div class="key-value"><span>Reasoning effort</span><strong>${html(value.reasoning_effort ?? "Unspecified")}</strong></div><div class="key-value"><span>Native Codex client</span><strong>${html(harness?.nativeVersion ?? "Not recorded")}</strong></div><div class="key-value"><span>Frozen commit</span><strong class="mono">${commitLink(commit)}</strong></div><div class="key-value"><span>Sandbox / approval</span><strong>${html(settings.sandbox_mode ?? "Unknown")} / ${html(settings.approval_policy ?? "Unknown")}</strong></div>${comparison[`${side}_release_digest`] ? `<div class="key-value"><span>Release digest</span><strong class="mono">${html(comparison[`${side}_release_digest`].slice(0, 16))}</strong></div>` : ""}${harness?.files?.length ? `<div class="config-files">${harness.files.map((file) => disclosure(`config-${side}-${file.path}`, html(file.path), `<pre class="evidence-text">${html(decodeFile(file))}</pre>`)).join("")}</div>` : `<p class="field-hint">Frozen file contents are not available in this evidence snapshot.</p>`}</div>`;
    })
    .join(
      "",
    )}</div>${report ? `<p class="comparison-note digest-note">Report SHA-256: <span class="mono">${html(report.report_hash)}</span></p>` : `<p class="comparison-note">This is a live configuration snapshot; the final comparison report has not been published.</p>`}`;
}
function renderPatch(file) {
  if (file.binary)
    return `<p class="comparison-note">Binary content changed. A text diff is not available.</p>`;
  if (typeof file.diff === "string")
    return `<pre class="patch-code" aria-label="${html(`Source diff for ${file.path}`)}">${file.diff
      .split("\n")
      .map(
        (line) =>
          `<span class="diff-line ${/^@@|^---|^\+\+\+/.test(line) ? "diff-context" : line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : ""}">${html(line) || " "}</span>`,
      )
      .join("")}</pre>`;
  return `<div class="split-columns"><div><h4>Before</h4><pre class="evidence-text">${html(file.before ?? "File absent")}</pre></div><div><h4>Captured after</h4><pre class="evidence-text">${html(file.after ?? "File absent")}</pre></div></div>`;
}
function renderReviewPr(detail, attempt) {
  const runId = detail.run.id,
    key = `${runId}/${attempt.id}`,
    request = state.reviewPrStates.get(key),
    pr = attempt.reviewPr ?? request?.pr;
  if (pr)
    return `<div class="review-pr-action"><a class="button button-secondary small" data-review-link="${html(key)}" href="${html(safeUrl(pr.url))}" target="_blank" rel="noopener noreferrer">View ${pr.draft ? "draft " : ""}review PR #${html(pr.number)} ↗</a><p class="field-hint">${pr.state === "closed" ? "Closed review PR. " : ""}The recorded review snapshot is linked to its task, evaluation, and harness configuration. Evaluation evidence is unchanged; nothing is merged automatically.</p>${pr.state === "unknown" ? `<p class="notice" role="status">Current GitHub status unavailable. The recorded review URL is retained.${pr.metadataError ? ` ${html(pr.metadataError)}` : ""}</p>` : ""}</div>`;
  if (!attempt.changes?.captured || !attempt.changes.files?.length) return "";
  return `<div class="review-pr-action"><button class="button button-secondary small" type="button" data-review-attempt="${html(attempt.id)}" data-review-run="${runId}" ${request?.busy ? 'disabled aria-busy="true"' : ""}>${request?.busy ? "Creating draft review PR…" : "Create draft review PR"}</button><p class="field-hint">Publishes only this captured attempt against its frozen task base, with links to the evaluation and harness PR. Results and policy violations remain visible. Nothing is merged automatically.</p>${request?.error ? `<div class="notice error" role="alert">${html(request.error)}</div>` : ""}</div>`;
}
async function createReviewPr(runId, attemptId) {
  runId = Number(runId);
  const key = `${runId}/${attemptId}`,
    detail = state.details.get(runId),
    attempt = detail?.attempts?.find((value) => value.id === attemptId);
  if (
    !attempt?.changes?.captured ||
    !attempt.changes.files?.length ||
    attempt.reviewPr ||
    state.reviewPrStates.get(key)?.busy ||
    state.reviewPrStates.get(key)?.pr
  )
    return;
  state.reviewPrStates.set(key, { busy: true });
  renderDetail();
  try {
    const pr = await api(
      `/api/runs/${runId}/attempts/${encodeURIComponent(attemptId)}/review-pr`,
      {
        method: "POST",
        headers: { "x-fullbeam-csrf": state.overview.csrfToken },
      },
    );
    if (!Number.isInteger(pr.number) || safeUrl(pr.url) === "#")
      throw new Error(
        "The server did not return a valid review PR receipt. Refresh the evaluation before retrying.",
      );
    state.reviewPrStates.set(key, { busy: false, pr });
    toast(
      `Review PR #${pr.number} is available. The evaluation result is unchanged.`,
    );
    await loadDetail(runId, true);
  } catch (error) {
    state.reviewPrStates.set(key, { busy: false, error: error.message });
  } finally {
    if (state.selected === runId) renderDetail();
  }
}
function renderChanges(detail) {
  const attempts = detail.attempts ?? [];
  if (!attempts.length)
    return empty(
      "No generated changes recorded yet",
      "Each completed attempt will show its actual captured file changes and independent verification outcomes.",
      "⇄",
    );
  return `<div class="note-box">These are captured sandbox outputs. Each attempt can become a separate draft review PR against its own frozen task base, linked to the evaluation and harness configuration PR. Draft PRs preserve observed failures and are never merged automatically.</div><div class="attempt-changes">${attempts
    .map((attempt) => {
      const changes = attempt.changes,
        verifier = attempt.verifier,
        native = attempt.nativeConfiguration;
      const files = changes?.files ?? [],
        violations = changes?.violations ?? [];
      const heading = `<div class="attempt-summary"><div><strong>${html(attempt.taskId)}</strong><span>${html(attempt.release)} · attempt ${attempt.repeat}/2 · ${html(attempt.model ?? "Unknown model")}</span></div><div>${outcomeBadge(attempt.outcome)}<span class="change-count">${changes?.captured ? `${files.length} changed file${files.length === 1 ? "" : "s"}` : "Capture unavailable"}</span></div></div>`;
      const content = `<div class="attempt-change-body">${native ? `<div class="task-metadata"><span>Observed native model: <strong>${html(native.model ?? "Unknown")}</strong></span><span>Reasoning: ${html(native.reasoningEffort ?? "Unknown")}</span><span>Native settings: ${html(native.status ?? "Unknown")}</span></div>` : ""}${violations.length ? `<div class="notice error"><strong>Protected-output violations</strong><ul>${violations.map((value) => `<li>${html(value)}</li>`).join("")}</ul></div>` : ""}<p class="comparison-note">${html(attempt.reason ?? "")}</p>${renderReviewPr(detail, attempt)}<div class="verification-evidence"><h4>Independent verification</h4>${verifier ? `<div class="task-metadata"><span>${html(verifier.status)}</span><span>Build: ${verifier.buildPassed === true ? "passed" : verifier.buildPassed === false ? "failed" : "not observed"}</span><span>Startup: ${verifier.startupPassed === true ? "passed" : verifier.startupPassed === false ? "failed" : "not observed"}</span></div>${verifier.checks?.length ? `<div class="check-results">${verifier.checks.map((check) => `<div>${badge({ label: check.status, tone: check.status === "PASS" ? "success" : check.status === "FAIL" ? "failed" : "warning" })}<code>${html(check.id)}</code>${check.detail ? `<span>${html(check.detail)}</span>` : ""}</div>`).join("")}</div>` : `<p class="field-hint">No behavioral check results were recorded for this verifier execution.</p>`}` : `<p class="field-hint">No independent verifier execution was recorded for this attempt. See its outcome and policy evidence above.</p>`}</div>${!changes?.captured ? `<p class="comparison-note">Captured source changes are unavailable. No diff is inferred from the outcome.</p>` : !files.length ? `<p class="comparison-note">No file changes were observed in the captured sandbox.</p>` : files.map((file) => disclosure(`file-${attempt.id}-${file.path}`, `<span class="file-summary"><code>${html(file.path)}</code><span class="file-status">${html(file.status)}${violations.some((value) => value.includes(file.path)) ? " · protected violation" : ""}</span></span>`, renderPatch(file), "file-diff")).join("")}${changes?.truncated ? `<p class="notice error">The returned change display is truncated; inspect the retained private artifact for complete evidence.</p>` : ""}</div>`;
      return disclosure(
        `attempt-${attempt.id}`,
        heading,
        content,
        "attempt-disclosure",
      );
    })
    .join("")}</div>`;
}
function decodeFile(file) {
  if (typeof file.text === "string") return file.text;
  if (
    file.encoding === "base64" ||
    (typeof file.sha256 === "string" && typeof file.size === "number")
  ) {
    try {
      return new TextDecoder().decode(
        Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
      );
    } catch {
      return "[Unable to decode recorded file]";
    }
  }
  return file.content ?? "";
}

async function compareRuns() {
  state.compareSelected = $("#compare-selected").value;
  state.compareReference = $("#compare-reference").value;
  const selected = state.details.get(Number(state.compareSelected));
  if (!selected?.report) {
    toast("Choose an evaluation with a recorded report.");
    return;
  }
  if (state.compareSelected === state.compareReference) {
    toast("Choose a different reference evaluation.");
    return;
  }
  $("#compare-button").disabled = true;
  try {
    if (state.compareReference === "all") {
      $("#comparison-results").innerHTML = empty(
        "Reading historical evidence",
        "Loading available completed reports for the comparison…",
        "◌",
      );
      await loadReports(
        state.runs.filter(
          (run) => completed(run) && !state.details.has(run.id),
        ),
      );
    }
    const references =
      state.compareReference === "all"
        ? [...state.details.entries()]
            .filter(
              ([id, detail]) =>
                id !== Number(state.compareSelected) && detail.report,
            )
            .map(([, detail]) => detail)
        : [state.details.get(Number(state.compareReference))].filter(
            (detail) => detail?.report,
          );
    if (!references.length) {
      $("#comparison-results").innerHTML = empty(
        "A second report makes a comparison",
        "Run another evaluation, or select a different recorded reference.",
        "⇄",
      );
      return;
    }
    const selectedTasks = new Set(
      releaseRows(selected.report).map((row) => row.slot.task_id),
    );
    const allReferenceRows = references.flatMap((detail) =>
      releaseRows(detail.report),
    );
    const sharedTasks = [...selectedTasks].filter((task) =>
      allReferenceRows.some((row) => row.slot.task_id === task),
    );
    if (!sharedTasks.length) {
      $("#comparison-results").innerHTML = empty(
        "No shared tasks",
        "These evaluations ran different tasks and cannot be compared directly.",
        "⇄",
      );
      return;
    }
    const taskScope = new Set(sharedTasks);
    const left = metrics(selected, "candidate", taskScope),
      right = aggregate(references, "candidate", taskScope);
    const compatible = references.every(
      (detail) =>
        detail.report.comparison.benchmark_digest ===
          selected.report.comparison.benchmark_digest &&
        detail.report.comparison.policy_digest ===
          selected.report.comparison.policy_digest &&
        detail.report.comparison.controller_commit_sha ===
          selected.report.comparison.controller_commit_sha,
    );
    const rateDelta =
      left.passRate !== null && right.passRate !== null
        ? (left.passRate - right.passRate) * 100
        : null;
    const costDelta =
      left.completeCost && right.completeCost
        ? left.cost / left.attempts - right.cost / right.attempts
        : null;
    const tokenDelta =
      left.completeTokens && right.completeTokens
        ? left.tokens / left.attempts - right.tokens / right.attempts
        : null;
    const signed = (value, format) =>
      value === null
        ? "Unknown"
        : `${value > 0 ? "+" : value < 0 ? "−" : ""}${format(Math.abs(value))}`;
    const tiles = [
      {
        label: "CANDIDATE PASS RATE",
        value: percent(left.passRate),
        delta: rateDelta,
        good: rateDelta >= 0,
        text: `${signed(rateDelta, (n) => `${n.toFixed(1)} pp`)} vs ${percent(right.passRate)} reference`,
      },
      {
        label: "COST / CANDIDATE ATTEMPT",
        value: left.completeCost ? money(left.cost / left.attempts) : "Unknown",
        delta: costDelta,
        good: costDelta <= 0,
        text: `${signed(costDelta, money)} vs reference average`,
      },
      {
        label: "TOKENS / CANDIDATE ATTEMPT",
        value: left.completeTokens
          ? compact(left.tokens / left.attempts)
          : "Unknown",
        delta: tokenDelta,
        good: tokenDelta <= 0,
        text: `${signed(tokenDelta, number)} vs reference average`,
      },
    ];
    $("#comparison-results").className = "comparison-body";
    $("#comparison-results").innerHTML =
      `<p class="comparison-note">Evaluation #${state.compareSelected} against ${references.length} historical report${references.length === 1 ? "" : "s"}. ${sharedTasks.length} shared tasks only; candidate configurations are compared and reference numbers are pooled across observed attempts. ${left.passes}/${left.attempts} selected passes · ${right.passes}/${right.attempts} reference passes.</p>${!compatible ? `<div class="notice error">Benchmark, policy, or controller versions differ. These are descriptive historical differences, not a controlled comparison.</div>` : ""}${left.valid < left.attempts || right.valid < right.attempts ? `<div class="notice error">Some attempts are incomplete. Pass rates include observed attempts, with missing or invalid evidence visible in run details.</div>` : ""}<div class="comparison-grid">${tiles.map((tile) => `<div class="comparison-metric"><div class="metric-label">${tile.label}</div><div class="metric-value">${html(tile.value)}</div><div class="delta ${tile.delta === null ? "" : tile.good ? "delta-good" : "delta-bad"}">${html(tile.text)}</div></div>`).join("")}</div><div class="section-heading"><h3>Task-by-task results</h3><div class="token-legend"><span class="legend"><i class="legend-dot purple"></i> Selected</span><span class="legend">◇ Historical reference</span></div></div><div class="comparison-task-chart">${sharedTasks
        .map((task) => {
          const a = releaseRows(selected.report).filter(
              (row) => row.slot.task_id === task,
            ),
            b = allReferenceRows.filter((row) => row.slot.task_id === task);
          const ap = a.filter((row) => row.run.outcome === "PASS").length,
            bp = b.filter((row) => row.run.outcome === "PASS").length,
            delta = (ap / a.length - bp / b.length) * 100;
          return `<div class="task-comparison-row"><span>${html(task)}</span><svg viewBox="0 0 340 32" role="img" aria-label="${html(task)}: selected ${ap}/${a.length}, reference ${bp}/${b.length}"><rect x="0" y="0" width="340" height="11" rx="3" fill="#f0eef5"/><rect x="0" y="0" width="${(340 * ap) / a.length}" height="11" rx="3" fill="#8d73ed"/><rect x="0" y="20" width="340" height="11" rx="3" fill="#f0eef5"/><rect x="0" y="20" width="${(340 * bp) / b.length}" height="11" rx="3" fill="#bcb4d4"/></svg><div class="task-delta">${ap}/${a.length} vs ${bp}/${b.length}<div class="delta ${delta >= 0 ? "delta-good" : "delta-bad"}">${signed(delta, (n) => `${n.toFixed(0)} pp`)}</div></div></div>`;
        })
        .join(
          "",
        )}</div><p class="comparison-note">Historical reports may overlap in tasks or model aliases. These small seeded samples support investigation, not causal claims or production-release approval.</p>`;
  } finally {
    $("#compare-button").disabled = false;
  }
}

function populateModels() {
  const overview = state.overview;
  const previousModel = $("#model-select").value,
    previousEffort = $("#effort-select").value;
  const priorities = [
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-5.6-luna",
    overview.model,
  ];
  const models = (overview.models ?? []).filter(
    (model) =>
      priorities.includes(model.id) ||
      (/^(?:gpt-(?:[5-9]|[1-9]\d)(?:[.-]|$)|o[134](?:-|$)|codex-)/.test(
        model.id,
      ) &&
        !/audio|image|realtime|transcrib|tts|search|deep-research|moderation|embedding/.test(
          model.id,
        )),
  );
  models.sort((a, b) => {
    const ai = priorities.indexOf(a.id),
      bi = priorities.indexOf(b.id);
    return (
      (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.id.localeCompare(b.id)
    );
  });
  const labels = {
    "gpt-5.6-sol": "Sol",
    "gpt-6-astra": "Astra",
    "gpt-5.6-luna": "Luna",
  };
  $("#model-select").innerHTML = models.length
    ? `<option value="">Choose an available API model</option>${models.map((model) => `<option value="${html(model.id)}">${labels[model.id] ? `${labels[model.id]} · ` : ""}${html(model.id)}${model.id === overview.model ? " (current baseline)" : ""}</option>`).join("")}`
    : `<option value="">Coding model catalog unavailable</option>`;
  if (models.some((model) => model.id === previousModel))
    $("#model-select").value = previousModel;
  else if (models.some((model) => model.id === overview.model))
    $("#model-select").value = overview.model;
  $("#effort-select").innerHTML = (overview.reasoningEfforts ?? [])
    .map(
      (value) =>
        `<option value="${html(value)}">${html(value[0].toUpperCase() + value.slice(1))}</option>`,
    )
    .join("");
  $("#effort-select").value = (overview.reasoningEfforts ?? []).includes(
    previousEffort,
  )
    ? previousEffort
    : (overview.reasoningEffort ?? "high");
  $("#model-note").textContent = overview.modelError
    ? `Model catalog: ${overview.modelError}. Existing pull requests can still be evaluated.`
    : `${models.length} text/coding models from your API account. Audio, image and realtime models are excluded. Each model must support the selected reasoning level.`;
}
async function openDialog() {
  if (!state.overview) {
    toast("Connect to the local controller first.");
    return;
  }
  $("#run-dialog").showModal();
  $("#form-error").hidden = true;
  if (!$("#proposal-name").value)
    $("#proposal-name").value = `experiment-${new Date()
      .toISOString()
      .slice(5, 16)
      .replace(/[^0-9]/g, "")}`;
  if (state.harness) return;
  $("#harness-load-status").textContent =
    "Reading the protected default harness…";
  $("#instructions").disabled = true;
  $("#skills-index").disabled = true;
  $("#add-skill").disabled = true;
  $("#skill-file").disabled = true;
  try {
    state.harness = await api("/api/harness");
    for (const file of state.harness.files ?? []) {
      const text = decodeFile(file);
      if (file.path === "AGENTS.md") $("#instructions").value = text;
      else if (file.path === "skills.md") $("#skills-index").value = text;
      else if (file.path.startsWith(".agents/skills/"))
        state.skillEdits.set(file.path, text);
    }
    $("#instructions").disabled = false;
    $("#skills-index").disabled = false;
    $("#add-skill").disabled = false;
    $("#skill-file").disabled = false;
    $("#harness-load-status").textContent =
      `Editing protected default ${state.harness.head.slice(0, 12)}. Native permissions remain unchanged.`;
    renderSkillOptions();
  } catch (error) {
    $("#harness-load-status").textContent =
      `Harness files unavailable: ${error.message}. Model-only proposals still work.`;
  }
}
function renderSkillOptions() {
  $("#skill-file").innerHTML =
    `<option value="">Select a native skill file</option>${[
      ...state.skillEdits.keys(),
    ]
      .sort()
      .map((path) => `<option value="${html(path)}">${html(path)}</option>`)
      .join("")}`;
  $("#skill-file").value = state.skillPath;
}
function setMode(mode) {
  state.formMode = mode;
  $("#new-config-fields").hidden = mode !== "new";
  $("#existing-pr-fields").hidden = mode !== "existing";
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#proposal-name").required = mode === "new";
  $("#model-select").required = mode === "new";
  $("#existing-pr").required = mode === "existing";
}
async function submitRun(event) {
  event.preventDefault();
  const errorNode = $("#form-error");
  errorNode.hidden = true;
  let body;
  if (state.formMode === "existing")
    body = { pr: Number($("#existing-pr").value) };
  else {
    body = {
      name: $("#proposal-name").value.trim(),
      model: $("#model-select").value,
      reasoningEffort: $("#effort-select").value,
    };
    if (!body.model) {
      errorNode.textContent =
        "Select an actual available API model, or use an existing pull request.";
      errorNode.hidden = false;
      return;
    }
    if (state.harness) {
      const original = new Map(
        state.harness.files.map((file) => [file.path, decodeFile(file)]),
      );
      if ($("#instructions").value !== (original.get("AGENTS.md") ?? ""))
        body.instructions = $("#instructions").value;
      const skills = [...state.skillEdits]
        .filter(([path, content]) => content !== original.get(path))
        .map(([path, content]) => ({ path, content }));
      if ($("#skills-index").value !== (original.get("skills.md") ?? ""))
        skills.push({ path: "skills.md", content: $("#skills-index").value });
      if (skills.length) body.skills = skills;
    }
  }
  $("#submit-run").disabled = true;
  $("#submit-run").textContent = "Preparing evaluation…";
  try {
    const response = await api("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fullbeam-csrf": state.overview.csrfToken,
      },
      body: JSON.stringify(body),
    });
    $("#run-dialog").close();
    state.pendingTrigger = response.trigger ?? null;
    state.pendingJobId = response.jobId ?? null;
    if (response.id) state.selected = Number(response.id);
    if (response.jobId)
      state.jobs.unshift({
        jobId: response.jobId,
        name: body.name ?? `Pull request #${body.pr}`,
        status: response.status ?? "queued",
      });
    renderJobs();
    toast(
      response.jobId
        ? "Evaluation saved to the queue. It will start when the current run finishes."
        : `Evaluation dispatched${response.pr ? ` for PR #${response.pr}` : ""}. Waiting for GitHub Actions…`,
    );
    message(
      response.jobId
        ? "Your evaluation is queued. Requests run one workflow at a time; you can keep exploring previous results."
        : `New evaluation submitted${response.pr ? ` for pull request #${response.pr}` : ""}. Its live status will appear in your history.`,
      "success",
    );
    await refresh();
    $("#history").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    $("#submit-run").disabled = false;
    $("#submit-run").textContent = "Start evaluation →";
  }
}

$("#refresh").addEventListener("click", () => refresh(true));
$("#new-run").addEventListener("click", openDialog);
$("#close-dialog").addEventListener("click", () => $("#run-dialog").close());
$("#run-form").addEventListener("submit", submitRun);
$("#run-search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderRuns();
});
$("#status-filter").addEventListener("change", (event) => {
  state.filter = event.target.value;
  renderRuns();
});
$("#compare-selected").addEventListener("change", (event) => {
  state.compareSelected = event.target.value;
});
$("#compare-reference").addEventListener("change", (event) => {
  state.compareReference = event.target.value;
});
$("#compare-button").addEventListener("click", compareRuns);
$("#skill-file").addEventListener("change", (event) => {
  state.skillPath = event.target.value;
  $("#skill-content").disabled = !state.skillPath;
  $("#skill-content").value = state.skillEdits.get(state.skillPath) ?? "";
});
$("#skill-content").addEventListener("input", (event) => {
  if (state.skillPath)
    state.skillEdits.set(state.skillPath, event.target.value);
});
$("#add-skill").addEventListener("click", () => {
  $("#new-skill-fields").hidden = !$("#new-skill-fields").hidden;
  if (!$("#new-skill-fields").hidden) $("#new-skill-path").focus();
});
$("#confirm-skill").addEventListener("click", () => {
  const path = $("#new-skill-path").value.trim();
  if (
    !/^\.agents\/skills\/[a-zA-Z0-9_-]+\/[^\s]+$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..") ||
    path.includes("\\")
  ) {
    toast("Use a path such as .agents/skills/verify/SKILL.md.");
    return;
  }
  if (!state.skillEdits.has(path))
    state.skillEdits.set(
      path,
      path.endsWith("/SKILL.md")
        ? `---\nname: ${path.split("/")[2]}\ndescription: Describe when to use this skill.\n---\n\n`
        : "",
    );
  state.skillPath = path;
  renderSkillOptions();
  $("#skill-content").disabled = false;
  $("#skill-content").value = state.skillEdits.get(path);
  $("#new-skill-fields").hidden = true;
  $("#skill-content").focus();
});
document.addEventListener("click", (event) => {
  const review = event.target.closest("[data-review-attempt]");
  if (review) {
    createReviewPr(review.dataset.reviewRun, review.dataset.reviewAttempt);
    return;
  }
  const mode = event.target.closest("[data-mode]");
  if (mode) setMode(mode.dataset.mode);
  const row = event.target.closest("[data-run-id]");
  if (row) {
    state.selected = Number(row.dataset.runId);
    state.detailTab = "outcomes";
    renderDetail();
    renderRuns();
    loadDetail(state.selected);
    $("#run-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const tab = event.target.closest("[data-detail-tab]");
  if (tab) {
    state.detailTab = tab.dataset.detailTab;
    renderDetail();
  }
  if (event.target.closest("#close-detail")) {
    state.selected = null;
    renderDetail();
    renderRuns();
  }
  if (event.target.closest("#load-all"))
    loadReports(state.runs.filter(completed));
  const nav = event.target.closest("[data-nav]");
  if (nav)
    document
      .querySelectorAll("[data-nav]")
      .forEach((link) => link.classList.toggle("active", link === nav));
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.matches("[data-detail-tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = detailTabs,
      index = tabs.indexOf(state.detailTab);
    state.detailTab =
      event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs.at(-1)
          : tabs[
              (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                tabs.length
            ];
    renderDetail();
    $(`[data-detail-tab="${state.detailTab}"]`).focus();
  }
  if (
    ["Enter", " "].includes(event.key) &&
    event.target.matches("[data-run-id]")
  ) {
    event.preventDefault();
    event.target.click();
  }
});
document.addEventListener(
  "toggle",
  (event) => {
    const key = event.target.dataset?.disclosure;
    if (key)
      event.target.open
        ? state.openPanels.add(key)
        : state.openPanels.delete(key);
  },
  true,
);
setMode("new");
renderOverview();
await refresh(true);
setInterval(() => {
  if (!document.hidden) refresh();
}, 12000);
