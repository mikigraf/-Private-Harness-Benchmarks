import { digest } from "../core/integrity.js";
import type { PublishedReport } from "./types.js";
export function reportHash(
  report: Omit<PublishedReport, "report_hash"> | PublishedReport,
): string {
  const { report_hash: _, ...payload } = report as PublishedReport;
  return digest(payload);
}
export function modelSpendText(
  cost: PublishedReport["cost"],
  totalSlots: number,
): string {
  const amount = cost.coverage === 0 ? "UNKNOWN" : cost.measured_usd.toFixed(6);
  const label =
    cost.coverage > 0 && cost.coverage < totalSlots
      ? "Measured model spend subtotal USD"
      : "Measured model spend USD";
  return `${label}: ${amount}; coverage: ${cost.coverage}/${totalSlots}`;
}
export function validateReportIdentity(
  report: PublishedReport,
  runId: number,
  repositoryId: number,
): void {
  if (
    reportHash(report) !== report.report_hash ||
    report.comparison.github_actions_run_id !== String(runId) ||
    report.comparison.repository_id !== String(repositoryId) ||
    digest(report.comparison) !== report.comparison_digest
  )
    throw new Error("Report integrity, repository or run identity mismatch");
}
export function renderReport(
  report: PublishedReport,
  currentHead?: string,
): string {
  const c = report.comparison,
    s = report.summary,
    change = report.configuration_change;
  const lines = [
    `Fullbeam Compare — ${c.id}`,
    `Repository ID: ${c.repository_id}`,
    `Candidate PR #${c.candidate_pr} · evaluated head ${c.candidate_head_sha}`,
    `Applicability: ${report.applicability}`,
    `Baseline: ${c.baseline_source_sha}`,
    `Current release: ${c.current_release_digest}`,
    `Candidate release: ${c.candidate_release_digest}`,
    ...(change
      ? [
          `Configuration change: ${change.classification}`,
          `Current model: ${change.current.model}; reasoning effort: ${change.current.reasoning_effort ?? "UNSPECIFIED"}`,
          `Candidate model: ${change.candidate.model}; reasoning effort: ${change.candidate.reasoning_effort ?? "UNSPECIFIED"}`,
        ]
      : ["Configuration change: UNKNOWN (not recorded)"]),
    `Benchmark: ${c.benchmark_digest}`,
    `Policy: ${c.policy_digest}`,
    `Controller: ${c.controller_commit_sha}`,
    `Actions run: ${c.github_actions_run_id}`,
    `Evidence: ${c.evidence_maturity}`,
    `Execution: ${s.execution_completeness} · ${s.advisory}`,
    `Release decision: ${s.release_decision}`,
    "",
    `PIPELINE_DEMO on ${s.distinct_tasks} seeded tasks, 2 attempts per configuration. Task verification is calibrated; workload representativeness is not established. Not a production-release approval.`,
    "",
    "Task | risk | current | candidate | finding",
  ];
  for (const row of s.comparison_findings)
    lines.push(
      `${row.id} | ${row.risk} | ${row.current_successes}/${row.current_valid} valid (${row.current.length}/2 observed) | ${row.candidate_successes}/${row.candidate_valid} valid (${row.candidate.length}/2 observed) | ${row.finding}`,
    );
  lines.push(
    "",
    `Paired difference (complete tasks only): ${s.paired_difference === null ? "UNKNOWN" : s.paired_difference}`,
    `Eligible tasks: ${s.eligible_tasks}/${s.distinct_tasks}; eligible paired blocks: ${s.eligible_paired_blocks}`,
    `Invalid/missing attempts: ${s.invalid_or_missing_attempts}`,
    modelSpendText(report.cost, report.slots.length),
    `Cost per success USD: ${report.cost.cost_per_success === null ? "UNKNOWN" : report.cost.cost_per_success.toFixed(6)}`,
    `Instacloud per-attempt cost: UNKNOWN`,
    `Cleanup: ${report.cleanup_status}`,
    "",
    "Attempts",
  );
  for (const { slot, run } of report.runs) {
    lines.push(
      `${slot.id}: ${run.outcome} (${run.reason}); agent ${run.agent_duration_ms ?? "UNKNOWN"}ms / total ${run.total_duration_ms}ms`,
    );
    for (const check of run.checks.filter((x) => x.outcome !== "PASS"))
      lines.push(`  ${check.group} ${check.test_id}: ${check.outcome}`);
    lines.push(
      `  artifact hashes: ${run.artifacts.map((a) => a.sha256).join(", ")}`,
    );
  }
  lines.push(
    "",
    "Limitations",
    ...report.limitations.map((l) => `- ${l}`),
    "",
    `Report SHA-256: ${report.report_hash}`,
    `Recorded at: ${report.created_at}`,
  );
  if (currentHead)
    lines.splice(
      4,
      0,
      `Current PR head: ${currentHead} · applicability now: ${currentHead === c.candidate_head_sha ? "CURRENT" : "OUTDATED"}`,
    );
  return lines.join("\n");
}
