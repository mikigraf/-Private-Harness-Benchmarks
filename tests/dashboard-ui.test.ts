import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Execute the shipped browser handlers offline. No fetch implementation is
// installed, so these tests cannot create a remote review PR or evaluation.
async function browserFixture() {
  const source = await readFile(
    new URL("../src/dashboard/public/app.js", import.meta.url),
    "utf8",
  );
  const nodes = new Map<string, Record<string, unknown>>();
  const context = createContext({
    URL,
    Intl,
    document: {
      querySelector: (selector: string) => {
        if (!nodes.has(selector)) nodes.set(selector, {});
        return nodes.get(selector);
      },
    },
  });
  runInContext(
    source.slice(0, source.indexOf('$("#refresh").addEventListener')),
    context,
  );
  runInContext(
    `
    const requests = [], refreshes = [];
    let response = Promise.resolve({number: 19, url: 'https://github.com/owner/repo/pull/19', draft: true, state: 'open'});
    api = async (path, options) => { requests.push({path, ...options}); return response; };
    renderDetail = () => {};
    toast = () => {};
    loadDetail = async (id, force) => { refreshes.push({id, force}); };
    state.overview = {repository: 'owner/repo', csrfToken: 'fixture-csrf'};
    state.selected = 123;
    const attempt = {id: 'attempt/a?b', changes: {captured: true, files: [{path: 'src/task.ts'}]}};
    const detail = {run: {id: 123}, attempts: [attempt]};
    state.details.set(123, detail);
  `,
    context,
  );
  return {
    evaluate: (code: string) => runInContext(code, context),
    context,
    nodes,
  };
}

describe("dashboard attempt review actions (offline)", () => {
  it("sends only frozen IDs with CSRF, suppresses duplicate clicks, and force-refreshes the receipt", async () => {
    const browser = await browserFixture();
    let release!: (value: unknown) => void;
    browser.context.pendingResponse = new Promise((resolve) => {
      release = resolve;
    });
    browser.evaluate("response = pendingResponse");
    const pending = browser.evaluate("createReviewPr(123, attempt.id)");
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("requests.length")).toBe(1);
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      'disabled aria-busy="true"',
    );
    release({
      number: 19,
      url: "https://github.com/owner/repo/pull/19",
      draft: true,
      state: "open",
    });
    await pending;
    const request = browser.evaluate("requests[0]");
    expect(request).toEqual({
      path: "/api/runs/123/attempts/attempt%2Fa%3Fb/review-pr",
      method: "POST",
      headers: { "x-fullbeam-csrf": "fixture-csrf" },
    });
    expect(request).not.toHaveProperty("body");
    expect(browser.evaluate("refreshes")).toEqual([{ id: 123, force: true }]);
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      "View draft review PR #19",
    );
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("requests.length")).toBe(1);
  });

  it("keeps existing closed review PRs visible without offering another mutation", async () => {
    const browser = await browserFixture();
    browser.evaluate(
      "attempt.reviewPr = {number: 19, url: 'https://github.com/owner/repo/pull/19', draft: true, state: 'closed'}",
    );
    const markup = browser.evaluate("renderReviewPr(detail, attempt)");
    expect(markup).toContain('href="https://github.com/owner/repo/pull/19"');
    expect(markup).toContain("Closed review PR");
    expect(markup).not.toContain("data-review-attempt");
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("requests.length")).toBe(0);
  });

  it("retains the recorded review URL while showing unavailable current GitHub metadata", async () => {
    const browser = await browserFixture();
    browser.evaluate(
      "attempt.reviewPr = {number: 19, url: 'https://github.com/owner/repo/pull/19', draft: null, state: 'unknown', metadataError: '<provider unavailable>'}",
    );
    const markup = browser.evaluate("renderReviewPr(detail, attempt)");
    expect(markup).toContain('href="https://github.com/owner/repo/pull/19"');
    expect(markup).toContain("Current GitHub status unavailable");
    expect(markup).toContain("&lt;provider unavailable&gt;");
    expect(markup).not.toContain("View draft");
    expect(markup).not.toContain("data-review-attempt");
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("requests.length")).toBe(0);
  });

  it("never offers uncaptured or empty changes, but preserves review eligibility for captured policy failures", async () => {
    const browser = await browserFixture();
    browser.evaluate("attempt.changes.captured = false");
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toBe("");
    await browser.evaluate("createReviewPr(123, attempt.id)");
    browser.evaluate(
      "attempt.changes.captured = true; attempt.changes.files = []",
    );
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toBe("");
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("requests.length")).toBe(0);
    browser.evaluate(
      "attempt.changes.files = [{path:'tests/public/protected.ts'}]; attempt.outcome = 'POLICY_VIOLATION'",
    );
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      "Create draft review PR",
    );
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      "Results and policy violations remain visible",
    );
  });

  it("renders escaped errors and rejects a missing or unsafe PR receipt", async () => {
    const browser = await browserFixture();
    browser.evaluate(
      "api = async () => { throw new Error('<script>failure</script>'); }",
    );
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      'role="alert"',
    );
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      "&lt;script&gt;failure&lt;/script&gt;",
    );
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).not.toContain(
      "<script>",
    );
    browser.evaluate(
      "api = async () => ({number:19, url:'javascript:alert(1)'});",
    );
    await browser.evaluate("createReviewPr(123, attempt.id)");
    expect(browser.evaluate("renderReviewPr(detail, attempt)")).toContain(
      "did not return a valid review PR receipt",
    );
    expect(browser.evaluate("refreshes.length")).toBe(0);
  });
});

describe("dashboard observed usage completeness", () => {
  it("retains partial token subtotals but keeps missing cached counts and comparison deltas unknown", async () => {
    const browser = await browserFixture();
    browser.evaluate(`
      const makeDetail = (id, usage) => ({
        run: {id, status:'completed'},
        report: {comparison:{benchmark_digest:'b',policy_digest:'p',controller_commit_sha:'c'},runs:[{slot:{release_id:'candidate',task_id:'task'},run:{outcome:'PASS'}}]},
        attempts:[{release:'candidate',taskId:'task',outcome:'PASS',usage,cost:null}]
      });
      const partial = makeDetail(201, {inputTokens:1000,cachedInputTokens:null,outputTokens:50,complete:false});
      const complete = makeDetail(202, {inputTokens:2000,cachedInputTokens:1500,outputTokens:100,complete:true});
      state.details = new Map([[201,partial],[202,complete]]);
      document.querySelector('#compare-selected').value='201';
      document.querySelector('#compare-reference').value='202';
    `);
    const subtotal = browser.evaluate("metrics(partial, 'candidate')");
    expect(subtotal.tokens).toBe(1050);
    expect(subtotal.tokenCoverage).toBe(1);
    expect(subtotal.completeTokens).toBe(false);
    expect(subtotal.cachedCoverage).toBe(0);
    expect(browser.evaluate("tokenValue(metrics(partial), 'cached')")).toBe(
      "Unknown",
    );
    expect(browser.evaluate("tokenValue(metrics(partial))")).toBe("1,050*");
    browser.evaluate("renderUsageChart(metrics(partial))");
    expect(browser.nodes.get("#usage-chart")?.innerHTML).toContain(
      "Input · total",
    );
    expect(browser.nodes.get("#usage-chart")?.innerHTML).not.toContain(
      "Input · uncached",
    );
    await browser.evaluate("compareRuns()");
    const markup = browser.nodes.get("#comparison-results")
      ?.innerHTML as string;
    expect(markup).toMatch(
      /TOKENS \/ CANDIDATE ATTEMPT<\/div><div class="metric-value">Unknown/,
    );
    expect(markup).toContain("Unknown vs reference average");
    const combined = browser.evaluate(
      "aggregate([partial,complete], 'candidate')",
    );
    expect(combined).toMatchObject({
      tokens: 3150,
      input: 3000,
      output: 150,
      cached: 1500,
      tokenCoverage: 2,
      cachedCoverage: 1,
      completeTokenCoverage: 1,
      completeTokens: false,
    });
  });

  it("counts cached input once and permits complete deltas only with complete usage", async () => {
    const browser = await browserFixture();
    browser.evaluate(
      `const full = {attempts:[{release:'candidate',taskId:'task',outcome:'PASS',usage:{inputTokens:2000,cachedInputTokens:1500,outputTokens:100,complete:true},cost:null}]};`,
    );
    expect(browser.evaluate("metrics(full)")).toMatchObject({
      tokens: 2100,
      cached: 1500,
      completeTokenCoverage: 1,
      completeTokens: true,
    });
    expect(browser.evaluate("tokenValue(metrics(full), 'cached')")).toBe(
      "1,500",
    );
    browser.evaluate("full.attempts[0].usage.complete=false");
    expect(browser.evaluate("metrics(full).completeTokens")).toBe(false);
    expect(browser.evaluate("tokenValue(metrics(full), 'cached')")).toBe(
      "1,500*",
    );
  });
});
