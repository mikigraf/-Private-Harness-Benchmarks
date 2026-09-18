import { describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "../src/dashboard/server.js";
import {
  DashboardData,
  projectAttempts,
  validateStartInput,
} from "../src/dashboard/data.js";
import type { Config } from "../src/core/config.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/core/integrity.js";
import { reportHash } from "../src/product/report.js";
import { makeFile } from "../src/core/integrity.js";
import { zipSync, strToU8 } from "fflate";
import { capturedChanges } from "../src/dashboard/data.js";
import { DashboardLockError } from "../src/dashboard/persistence.js";
import { createAttemptReviewPr } from "../src/product/attempt-review.js";
vi.mock("../src/product/attempt-review.js", () => ({
  createAttemptReviewPr: vi.fn(),
}));

const config = {
  githubToken: "github-secret",
  openaiKey: "openai-secret",
  instacloudToken: "insta-secret",
  repository: "owner/repo",
  stateDir: "/tmp/fullbeam-dashboard-unit-tests",
} as Config;

describe("dashboard boundary", () => {
  it("overlays current PR state only after exact repository and frozen branch checks", async () => {
    const receipt = {
      pr: 17,
      url: "https://github.com/owner/repo/pull/17",
      headBranch: "owned/changes",
      baseBranch: "owned/base",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    };
    const priorDigest = digest(receipt);
    const repo = { id: 7, full_name: "owner/repo" };
    const observed = {
      number: 17,
      html_url: receipt.url,
      state: "closed",
      draft: false,
      head: { repo, ref: receipt.headBranch, sha: receipt.headSha },
      base: { repo, ref: receipt.baseBranch, sha: receipt.baseSha },
    };
    const data = new DashboardData(config);
    (data as any).client = { rest: async () => observed };
    expect(
      await (data as any).currentReviewMetadata(receipt, {
        comparison: { repository_id: "7" },
      }),
    ).toMatchObject({
      state: "closed",
      draft: false,
      provenanceVerified: true,
    });
    const changed = new DashboardData(config);
    (changed as any).client = {
      rest: async () => ({
        ...observed,
        head: { ...observed.head, sha: "c".repeat(40) },
      }),
    };
    expect(
      await (changed as any).currentReviewMetadata(receipt, {
        comparison: { repository_id: "7" },
      }),
    ).toMatchObject({
      state: "unknown",
      draft: null,
      provenanceVerified: false,
    });
    expect(digest(receipt)).toBe(priorDigest);
  });
  it("requires CSRF and accepts only recorded identity for publishing attempt review PRs", async () => {
    const reviewAttempt = vi.fn(async () => ({
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
    }));
    const app = createDashboardServer(config, {
      data: {
        overview: async () => ({}),
        listRuns: async () => [],
        run: async () => ({}),
        harness: async () => ({}),
        start: async () => ({}),
        reviewAttempt,
      },
    });
    try {
      const headers = {
        host: "127.0.0.1:4318",
        origin: "http://127.0.0.1:4318",
      };
      const token = (await app.inject({ url: "/api/overview", headers })).json()
        .csrfToken;
      const request = {
        method: "POST" as const,
        url: "/api/runs/42/attempts/attempt-one/review-pr",
      };
      expect((await app.inject({ ...request, headers })).statusCode).toBe(403);
      const authorized = { ...headers, "x-fullbeam-csrf": token };
      expect(
        (
          await app.inject({
            ...request,
            headers: authorized,
            payload: { files: [{ content: "browser injection" }] },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ ...request, headers: authorized })).statusCode,
      ).toBe(201);
      expect(reviewAttempt).toHaveBeenCalledExactlyOnceWith(42, "attempt-one");
    } finally {
      await app.close();
    }
  });

  it("persists exact attempt PR receipts, overlays archives, and never republishes on retry or restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-review-pr-"));
    const publish = vi.mocked(createAttemptReviewPr);
    publish.mockReset();
    try {
      const generation = {
        files: [makeFile("src/app.ts", "actual captured bytes")],
      };
      const input = {
        comparison: { github_actions_run_id: "42" },
        envelope: { run: { id: "attempt-one" } },
        generation,
        generationDigest: digest(generation),
      };
      const receipt = {
        schema_version: 1,
        repository: "owner/repo",
        runId: 42,
        attemptId: "attempt-one",
        generationDigest: input.generationDigest,
        pr: 17,
        url: "https://github.com/owner/repo/pull/17",
      };
      publish.mockResolvedValue(receipt as any);
      const detail = {
        attempts: [
          {
            id: "attempt-one",
            changes: { captured: true, files: [{ path: "src/app.ts" }] },
          },
        ],
      };
      const first = new DashboardData({ ...config, stateDir });
      (first as any).client = {
        rest: async () => {
          throw new Error("GitHub unavailable");
        },
      };
      await (first as any).saveReviewSnapshot(input);
      vi.spyOn(first, "run").mockResolvedValue(detail as any);
      const results = await Promise.all([
        first.reviewAttempt(42, "attempt-one"),
        first.reviewAttempt(42, "attempt-one"),
      ]);
      expect(results).toMatchObject([
        { ...receipt, number: 17 },
        { ...receipt, number: 17 },
      ]);
      expect(results[0]).toMatchObject({
        state: "unknown",
        draft: null,
        provenanceVerified: false,
      });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]![1]).toEqual(input);
      const restarted = new DashboardData({ ...config, stateDir });
      (restarted as any).client = {
        rest: async () => {
          throw new Error("GitHub unavailable");
        },
      };
      vi.spyOn(restarted, "run").mockResolvedValue(detail as any);
      expect(await restarted.reviewAttempt(42, "attempt-one")).toMatchObject({
        number: 17,
      });
      expect(
        (await (restarted as any).withReviewPrs(42, detail)).attempts[0]
          .reviewPr.url,
      ).toBe(receipt.url);
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(
        restarted.reviewAttempt(42, "nonexistent-attempt"),
      ).rejects.toThrow("no captured file changes");
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("requires the loopback host, same origin, and CSRF token for mutations", async () => {
    let calls = 0;
    const data = {
      overview: async () => ({ repository: "owner/repo" }),
      listRuns: async () => [],
      run: async () => ({}),
      harness: async () => ({}),
      start: async () => {
        calls++;
        return { id: 123 };
      },
    };
    const app = createDashboardServer(config, { data });
    const overview = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { host: "127.0.0.1:4318" },
    });
    const token = overview.json().csrfToken;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(overview.body).not.toContain("secret");
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { host: "127.0.0.1:4318", ...headers },
        payload: { pr: 8 },
      });
    expect(
      (
        await post({
          origin: "https://attacker.example",
          "x-fullbeam-csrf": token,
        })
      ).statusCode,
    ).toBe(403);
    expect((await post({ origin: "http://127.0.0.1:4318" })).statusCode).toBe(
      403,
    );
    expect(
      (
        await post({
          origin: "http://127.0.0.1:4318",
          "x-fullbeam-csrf": token,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          url: "/api/overview",
          headers: { host: "attacker.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toBe(1);
    await app.close();
  });

  it("rejects traversal, source edits and ambiguous existing-PR changes", () => {
    expect(() =>
      validateStartInput({
        name: "test",
        skills: [{ path: "../.env", content: "x" }],
      }),
    ).toThrow();
    expect(() =>
      validateStartInput({
        name: "test",
        skills: [{ path: "src/app.ts", content: "x" }],
      }),
    ).toThrow();
    expect(() => validateStartInput({ pr: 8, model: "gpt-5" })).toThrow();
    expect(
      validateStartInput({
        name: "test",
        skills: [{ path: ".agents/skills/test/SKILL.md", content: "text" }],
      }).skills,
    ).toHaveLength(1);
  });

  it("durably queues and deduplicates a request while another comparison is active", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
    try {
      const data = new DashboardData({ ...config, stateDir });
      vi.spyOn(data, "listRuns").mockResolvedValue([
        { id: 42, status: "in_progress" },
      ] as any);
      const first = await data.start({ pr: 8 });
      await data.processJobs();
      expect(await data.jobs()).toMatchObject([
        { jobId: first.jobId, status: "queued", waitingForRunId: 42 },
      ]);
      const restored = new DashboardData({ ...config, stateDir });
      expect((await restored.start({ pr: 8 })).jobId).toBe(first.jobId);
      expect(await restored.jobs()).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers a lost dispatch response by its persisted trigger without sending twice", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-restart-"));
    try {
      const data = new DashboardData({ ...config, stateDir });
      vi.spyOn(data, "listRuns").mockResolvedValue([]);
      vi.spyOn(data as any, "prepare").mockResolvedValue({
        pr: 8,
        head: { sha: "a".repeat(40), branch: "main" },
      });
      const dispatch = vi.fn(async () => {
        throw new Error("Response lost");
      });
      (data as any).actions = { dispatchWorkflow: dispatch };
      await data.start({ pr: 8 });
      await Promise.all([data.processJobs(), data.processJobs()]);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(
        await readFile(join(stateDir, "dashboard-jobs.json"), "utf8"),
      );
      const intent = saved.jobs[0].intent;
      expect(saved.jobs[0].status).toBe("dispatch_unknown");
      const restarted = new DashboardData({ ...config, stateDir });
      const secondDispatch = vi.fn();
      (restarted as any).actions = { dispatchWorkflow: secondDispatch };
      (restarted as any).client = {
        rest: async () => ({
          workflow_runs: [
            {
              id: 99,
              display_title: `Fullbeam compare ${intent.trigger}`,
              head_sha: intent.head,
              created_at: new Date(intent.dispatchedAt).toISOString(),
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/owner/repo/actions/runs/99",
            },
          ],
        }),
      };
      await restarted.processJobs();
      expect(secondDispatch).not.toHaveBeenCalled();
      expect(await restarted.jobs()).toMatchObject([
        { runId: 99, status: "running" },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("permits only one queue worker per state directory and releases it on close", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-lock-"));
    const first = new DashboardData({ ...config, stateDir });
    const second = new DashboardData({ ...config, stateDir });
    try {
      await first.open();
      await expect(second.open()).rejects.toThrow("already running");
      await first.close();
      await second.open();
      await second.close();
    } finally {
      await first.close();
      await second.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects new paid jobs after losing the database worker connection", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-lost-worker-"));
    try {
      const data = new DashboardData({ ...config, stateDir });
      await data.start({ pr: 8 });
      (data as any).postgres = {
        assertWorker: async () => {
          throw new DashboardLockError("worker connection lost");
        },
      };
      const prepare = vi.spyOn(data as any, "prepare");
      await data.processJobs();
      await expect(data.start({ pr: 9 })).rejects.toThrow(
        "worker connection lost",
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(await data.jobs()).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("retries delayed completed reports after restart without dispatching a paid run again", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-archive-retry-"));
    try {
      const first = new DashboardData({ ...config, stateDir });
      await first.start({ pr: 8 });
      Object.assign((first as any).queue[0], {
        status: "completed",
        conclusion: "success",
        runId: 42,
      });
      vi.spyOn(first, "run").mockResolvedValue({ report: null } as any);
      await first.processJobs();
      expect(await first.jobs()).toMatchObject([
        { status: "completed", archival: { status: "pending", attempts: 1 } },
      ]);
      const saved = JSON.parse(
        await readFile(join(stateDir, "dashboard-jobs.json"), "utf8"),
      );
      const restarted = new DashboardData({ ...config, stateDir });
      const dispatch = vi.fn();
      (restarted as any).actions = { dispatchWorkflow: dispatch };
      const comparison = { github_actions_run_id: "42", repository_id: "7" };
      const report = {
        comparison,
        comparison_digest: digest(comparison),
        report_hash: "",
      } as any;
      report.report_hash = reportHash(report);
      const detail = { run: { id: 42, status: "completed" }, report };
      vi.spyOn(restarted, "run").mockImplementation(async () => {
        await (restarted as any).archiveCompleted(42, detail);
        return detail as any;
      });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValue(saved.jobs[0].archival.nextAttemptAt + 1);
      try {
        await restarted.processJobs();
      } finally {
        now.mockRestore();
      }
      expect(await restarted.jobs()).toMatchObject([
        { status: "completed", archival: { status: "archived", attempts: 2 } },
      ]);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await (restarted as any).archived(42)).report.report_hash).toBe(
        report.report_hash,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("dashboard recorded accounting", () => {
  it("does not cache a completed projection whose immutable report validation failed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-cache-reject-"));
    try {
      const comparison = {
        id: "42-1-aaaaaaaa",
        github_actions_run_id: "42",
        repository_id: "7",
      };
      const report = {
        comparison,
        comparison_digest: digest(comparison),
        report_hash: "",
        runs: [],
        slots: [],
      } as any;
      report.report_hash = reportHash(report);
      const data = new DashboardData({ ...config, stateDir });
      (data as any).client = {
        rest: async () => ({
          id: 42,
          repository: { id: 7, full_name: "owner/repo" },
          path: ".github/workflows/fullbeam-compare.yml",
          display_title: "Fullbeam compare recorded",
          html_url: "https://github.com/owner/repo/actions/runs/42",
          head_sha: "a".repeat(40),
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-18T00:00:00Z",
        }),
        paginateByField: async () => [],
      };
      (data as any).actions = {
        listRunArtifacts: async () => [
          { id: 1, name: "fullbeam-evidence-42", expired: false },
        ],
        downloadRunArtifact: async () => ({
          zip: zipSync({ "report.json": strToU8(JSON.stringify(report)) }),
        }),
      };
      vi.spyOn(data as any, "evaluationDetails").mockResolvedValue({
        enrichmentVersion: 2,
      });
      vi.spyOn(data as any, "archiveCompleted").mockRejectedValue(
        new Error("Completed report differs from archived immutable evidence"),
      );
      await expect(data.run(42)).rejects.toThrow("report differs");
      expect((data as any).completed.has(42)).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("preserves the first completed archive during concurrent metadata reads and rejects a different report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-archive-race-"));
    try {
      const comparison = { github_actions_run_id: "42", repository_id: "7" };
      const report = {
        comparison,
        comparison_digest: digest(comparison),
        report_hash: "",
      } as any;
      report.report_hash = reportHash(report);
      const first = {
        run: { id: 42, status: "completed", updatedAt: "2026-09-18T00:00:00Z" },
        report,
        jobs: [{ status: "completed", conclusion: null }],
        marker: "first",
      };
      const later = {
        ...first,
        run: { ...first.run, updatedAt: "2026-09-18T00:00:01Z" },
        jobs: [{ status: "completed", conclusion: "success" }],
        marker: "later",
      };
      const data = new DashboardData({ ...config, stateDir });
      const read = (data as any).archived.bind(data);
      let arrivals = 0,
        releaseReads!: () => void,
        releaseFirstWrite!: () => void;
      const bothReading = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const firstWritten = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      vi.spyOn(data as any, "archived").mockImplementation(
        async (...args: unknown[]) => {
          if (++arrivals <= 2) {
            if (arrivals === 2) releaseReads();
            await bothReading;
            return null;
          }
          return read(...args);
        },
      );
      const store = (data as any).store,
        write = store.immutable.bind(store);
      vi.spyOn(store, "immutable").mockImplementation(
        async (...args: unknown[]) => {
          const [path, value] = args as [string, any];
          if (value.detail?.marker === "later") await firstWritten;
          await write(path, value);
          if (value.detail?.marker === "first") releaseFirstWrite();
        },
      );
      await Promise.all([
        (data as any).archiveCompleted(42, first),
        (data as any).archiveCompleted(42, later),
      ]);
      const path = join(stateDir, "dashboard/completed/42.json");
      const bytes = await readFile(path, "utf8");
      expect(JSON.parse(bytes).detail).toEqual(first);
      await (data as any).archiveCompleted(42, later);
      expect(await readFile(path, "utf8")).toBe(bytes);
      const changedReport = {
        ...report,
        additionalClaim: "different report",
        report_hash: "",
      };
      changedReport.report_hash = reportHash(changedReport as any);
      await expect(
        (data as any).archiveCompleted(42, { ...later, report: changedReport }),
      ).rejects.toThrow("report differs");
      expect(await readFile(path, "utf8")).toBe(bytes);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("retains observed cancelled workflow history after remote expiry without inventing a report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-summary-"));
    try {
      const first = new DashboardData({ ...config, stateDir });
      (first as any).client = {
        paginateByField: async () => [
          {
            id: 77,
            display_title: "Fullbeam compare actual-trigger",
            status: "completed",
            conclusion: "cancelled",
            created_at: "2026-09-18T00:00:00Z",
            updated_at: "2026-09-18T00:01:00Z",
            html_url: "https://github.com/owner/repo/actions/runs/77",
            head_sha: "a".repeat(40),
          },
        ],
      };
      await Promise.all([first.listRuns(), first.listRuns()]);
      const restarted = new DashboardData({ ...config, stateDir });
      (restarted as any).client = {
        paginateByField: async () => {
          throw new Error("Remote workflow expired");
        },
        rest: async () => {
          throw new Error("Remote workflow expired");
        },
      };
      expect(await restarted.listRuns()).toMatchObject([
        { id: 77, conclusion: "cancelled", archived: true },
      ]);
      expect(await restarted.run(77)).toMatchObject({
        run: { id: 77, conclusion: "cancelled" },
        report: null,
        attempts: [],
        archived: true,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("shows captured source edits and rejected protected edits without inventing changes", () => {
    const before = [
      makeFile("src/app.ts", "before\n"),
      makeFile("AGENTS.md", "rules\n"),
    ];
    const after = [
      makeFile("src/app.ts", "after\n"),
      makeFile("AGENTS.md", "changed rules\n"),
    ];
    const captured = capturedChanges(before, {
      integrityVerified: true,
      beforeManifest: before.map(({ content, ...f }) => f),
      files: after,
      violations: ["AGENTS.md was modified"],
    });
    expect(captured.files).toHaveLength(2);
    expect(captured.files.find((f) => f.path === "src/app.ts")).toMatchObject({
      before: "before\n",
      after: "after\n",
      status: "modified",
    });
    expect(captured.violations).toEqual(["AGENTS.md was modified"]);
    expect(() =>
      capturedChanges([makeFile("src/app.ts", "wrong input")], {
        integrityVerified: true,
        beforeManifest: before.map(({ content, ...f }) => f),
        files: after,
      }),
    ).toThrow("frozen generation input");
  });

  it("retries temporarily missing completed artifacts and later loads the actual report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-eventual-"));
    try {
      const comparison = {
        id: "42-1-aaaaaaaa",
        github_actions_run_id: "42",
        repository_id: "7",
        controller_commit_sha: "a".repeat(40),
      };
      const report = {
        comparison,
        comparison_digest: digest(comparison),
        report_hash: "",
        runs: [],
        slots: [],
      } as any;
      report.report_hash = reportHash(report);
      const data = new DashboardData({ ...config, stateDir });
      const run = {
        id: 42,
        repository: { id: 7, full_name: config.repository },
        path: ".github/workflows/fullbeam-compare.yml",
        display_title: "Fullbeam compare trigger",
        status: "completed",
        conclusion: "success",
        head_sha: "a".repeat(40),
        html_url: "https://github.com/owner/repo/actions/runs/42",
        created_at: "2026-09-18T00:00:00Z",
        updated_at: "2026-09-18T00:00:01Z",
      };
      (data as any).client = {
        rest: async (_method: string, path: string) => {
          if (path === "actions/runs/42") return run;
          throw new Error("Task enrichment unavailable in this fixture");
        },
        paginateByField: async () => [],
      };
      const listing = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { id: 1, name: "fullbeam-evidence-42", expired: false },
        ]);
      (data as any).actions = {
        listRunArtifacts: listing,
        downloadRunArtifact: async () => ({
          zip: zipSync({ "report.json": strToU8(JSON.stringify(report)) }),
        }),
      };
      expect(((await data.run(42)) as any).report).toBeNull();
      expect(((await data.run(42)) as any).report.report_hash).toBe(
        report.report_hash,
      );
      expect(listing).toHaveBeenCalledTimes(2);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("retains verified completed evidence across restart and expired remote history", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dashboard-archive-"));
    try {
      const comparison = { github_actions_run_id: "42", repository_id: "7" };
      const report = {
        comparison,
        comparison_digest: digest(comparison),
        report_hash: "",
      } as any;
      report.report_hash = reportHash(report);
      const detail = {
        run: {
          id: 42,
          name: "real observed comparison",
          status: "completed",
          createdAt: "2026-09-18T00:00:00Z",
        },
        report,
        artifactError: null,
        attempts: [
          { id: "recorded-attempt", usage: { inputTokens: 12 }, cost: null },
        ],
        harnesses: {
          current: {
            files: [{ path: "AGENTS.md", content: "frozen instructions" }],
          },
        },
      };
      const data = new DashboardData({ ...config, stateDir });
      await (data as any).archiveCompleted(42, detail);
      const restarted = new DashboardData({ ...config, stateDir });
      (restarted as any).client = { paginateByField: async () => [] };
      expect(await restarted.listRuns()).toMatchObject([
        { id: 42, archived: true },
      ]);
      expect(await restarted.run(42)).toMatchObject({
        archived: true,
        attempts: detail.attempts,
        harnesses: detail.harnesses,
      });
      const path = join(stateDir, "dashboard/completed/42.json");
      const altered = JSON.parse(await readFile(path, "utf8"));
      altered.detail.attempts[0].usage.inputTokens = 999;
      await writeFile(path, JSON.stringify(altered));
      await expect(
        new DashboardData({ ...config, stateDir }).run(42),
      ).rejects.toThrow("integrity");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("splits cached/uncached input and output using the recorded matching model rate", () => {
    const report = {
      configuration_change: {
        current: { model: "model-a" },
        candidate: { model: "model-b" },
      },
      runs: [
        {
          slot: { task_id: "task", release_id: "current" },
          run: {
            id: "attempt",
            outcome: "PASS",
            usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 200,
              complete: true,
            },
            rate_record_artifact_id: "rate",
            artifacts: [],
          },
        },
      ],
    } as any;
    const objects = new Map<string, any>([
      ["rate", { model: "model-a", input: 2, cached: 0.5, output: 8 }],
    ]);
    const row = projectAttempts(report, objects)[0]!;
    expect(row.cost).toEqual({
      uncachedInputUsd: 0.0012,
      cachedInputUsd: 0.0002,
      outputUsd: 0.0016,
      totalUsd: 0.003,
    });
    expect(row.usage?.reasoningTokens).toBeNull();
    report.runs[0].run.artifacts = [{ id: "generation" }];
    objects.set("generation", {
      events: JSON.stringify({
        type: "turn.completed",
        usage: { reasoning_output_tokens: 336 },
      }),
    });
    expect(projectAttempts(report, objects)[0]!.usage?.reasoningTokens).toBe(
      336,
    );
    objects.set("rate", { model: "model-b", input: 2, cached: 0.5, output: 8 });
    expect(projectAttempts(report, objects)[0]!.cost).toBeNull();
    report.runs[0].run.usage = null;
    expect(projectAttempts(report, objects)[0]!.usage).toBeNull();
  });

  it("labels catalog fallback as an estimate and preserves explicit zero recorded rates", () => {
    const report = {
      configuration_change: { current: { model: "gpt-5.6-sol" } },
      runs: [
        {
          slot: { task_id: "task", release_id: "current" },
          run: {
            id: "a",
            usage: {
              input_tokens: 1000,
              cached_input_tokens: 500,
              output_tokens: 10,
              complete: true,
            },
            artifacts: [],
            rate_record_artifact_id: "rate",
          },
        },
      ],
    } as any;
    const objects = new Map<string, any>();
    expect(projectAttempts(report, objects)[0]!.pricingSource).toContain(
      "catalog estimate",
    );
    expect(projectAttempts(report, objects)[0]!.cost?.totalUsd).toBeCloseTo(
      0.0024,
    );
    objects.set("rate", {
      model: "gpt-5.6-sol",
      input: 0,
      cached: 0,
      output: 0,
    });
    expect(projectAttempts(report, objects)[0]!.cost?.totalUsd).toBe(0);
    expect(projectAttempts(report, objects)[0]!.pricingSource).toContain(
      "Recorded",
    );
  });
});
