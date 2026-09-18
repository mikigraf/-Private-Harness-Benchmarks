import { it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { buildSchedule } from "../src/product/schedule.js";
import { readArtifactJson } from "../src/product/actions.js";
import { validateSubmittedFiles, makeFile } from "../src/core/integrity.js";
import { summarize, parseUsage } from "../src/comparison/summarize.js";
import type { Task, HarnessRelease } from "../src/core/records.js";
it("pairs two attempts per side with distinct slots even when release digests match", () => {
  const task = { id: "fixture", digest: "a".repeat(64) } as Task;
  const r = { digest: "b".repeat(64) } as HarnessRelease;
  const slots = buildSchedule(
    "test-comparison",
    [task],
    { current: r, candidate: r },
    "ordering-only",
  );
  expect(slots).toHaveLength(4);
  expect(new Set(slots.map((s) => s.id)).size).toBe(4);
  for (const repeat of [1, 2]) {
    const block = slots.filter((s) => s.repeat === repeat);
    expect(new Set(block.map((s) => s.block_id)).size).toBe(1);
    expect(block.map((s) => s.release_id).sort()).toEqual([
      "candidate",
      "current",
    ]);
  }
  expect(
    buildSchedule(
      "test-comparison",
      [task],
      { current: r, candidate: r },
      "ordering-only",
    ),
  ).toEqual(slots);
});
it("treats artifact paths and ambiguity as data boundary failures", () => {
  expect(
    readArtifactJson(
      zipSync({ "report.json": strToU8('{"synthetic":true}') }),
      "report.json",
    ),
  ).toEqual({ synthetic: true });
  expect(() =>
    readArtifactJson(
      zipSync({ "../report.json": strToU8("{}") }),
      "report.json",
    ),
  ).toThrow();
  expect(() =>
    readArtifactJson(
      zipSync({
        "a/report.json": strToU8("{}"),
        "b/report.json": strToU8("{}"),
      }),
      "report.json",
    ),
  ).toThrow();
});
it("protects nested native instructions even under an allowed source prefix", () => {
  const before = [makeFile("src/AGENTS.md", "trusted")];
  expect(
    validateSubmittedFiles(before, [makeFile("src/AGENTS.md", "altered")])
      .violations,
  ).toEqual(["src/AGENTS.md"]);
});
it("keeps shared failures and invalid attempts visible without production approval", () => {
  const report = summarize([
    {
      id: "task",
      risk: "CRITICAL",
      current: ["PASS", "PASS"],
      candidate: ["INFRA_ERROR", "FUNCTIONAL_FAIL"],
    },
  ]);
  expect(report.execution_completeness).toBe("INCOMPLETE");
  expect(report.eligible_tasks).toBe(0);
  expect(report.invalid_or_missing_attempts).toBe(1);
  expect(report.release_decision).toBe("NOT_QUALIFIED_FOR_PRODUCTION");
});
it("captures native event usage without interpreting agent claims as checks", () => {
  expect(
    parseUsage(
      'tests pass\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20}}\n',
    ),
  ).toEqual({
    input_tokens: 100,
    cached_input_tokens: 50,
    output_tokens: 20,
    complete: true,
  });
  expect(parseUsage("All tests pass")).toBeNull();
});

import { validateReportIdentity, reportHash } from "../src/product/report.js";
import { digest } from "../src/core/integrity.js";
import type { PublishedReport } from "../src/product/types.js";
it("revalidates stored report bytes and repository/run identity on every read", () => {
  const comparison = {
    github_actions_run_id: "1234",
    repository_id: "42",
  } as PublishedReport["comparison"];
  const report = {
    comparison,
    comparison_digest: digest(comparison),
    report_hash: "",
  } as PublishedReport;
  report.report_hash = reportHash(report);
  expect(() => validateReportIdentity(report, 1234, 42)).not.toThrow();
  expect(() => validateReportIdentity(report, 1234, 43)).toThrow();
  expect(() => validateReportIdentity(report, 1235, 42)).toThrow();
  expect(() =>
    validateReportIdentity({ ...report, cleanup_status: "FAILED" }, 1234, 42),
  ).toThrow();
});

import { modelSpendText } from "../src/product/report.js";
it("renders missing model rates as UNKNOWN and partial coverage as a subtotal", () => {
  const cost = {
    measured_usd: 0,
    coverage: 0,
    cost_per_success: null,
    instacloud_cost: null,
  };
  expect(modelSpendText(cost, 12)).toContain("UNKNOWN");
  expect(
    modelSpendText({ ...cost, coverage: 1, measured_usd: 0.1 }, 12),
  ).toContain("subtotal USD: 0.100000");
});
