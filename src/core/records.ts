import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { recordDigest } from "./integrity.js";
import type { ArtifactRef } from "./store.js";
import type { Outcome, Usage } from "../comparison/summarize.js";
export interface HarnessRelease {
  kind: "HarnessRelease";
  schema_version: 1;
  id: string;
  digest: string;
  source_commit: string;
  adapter: "codex-cli";
  client_version: string;
  requested_model: string;
  reported_model: string | null;
  mutable_model_alias: boolean;
  native_files: { path: string; sha256: string }[];
  effective_settings_sha256: string;
  tool_manifest_sha256: string;
  application_runtime_digest: string;
  generation_image_digest: string;
  permission_policy_sha256: string;
  agent_timeout_seconds: number;
}
export interface Task {
  kind: "Task";
  schema_version: 1;
  id: string;
  digest: string;
  repository_id: string;
  repository_full_name: string;
  issue_number: number;
  pull_request_number: number;
  issue_node_id: string;
  pull_request_node_id: string;
  link_evidence_artifact: ArtifactRef;
  base_sha: string;
  reference_sha: string;
  issue_snapshot_sha256: string;
  prompt_cutoff: string;
  source_bundle_sha256: string;
  reference_patch_sha256: string;
  verifier_sha256: string;
  dependency_lock_sha256: string;
  application_runtime_digest: string;
  verifier_image_digest: string;
  origin: "SEEDED_DEMO" | "PRIVATE_HISTORY" | "PUBLIC_HISTORY";
  visibility: "PRIVATE" | "PUBLIC";
  quality_tier: "BRONZE" | "SILVER" | "GOLD";
  disposition: "ACTIVE" | "QUARANTINED" | "EXCLUDED";
  history_fidelity: "SNAPSHOT_BEFORE_SOLUTION" | "RECONSTRUCTED" | "UNKNOWN";
  suite_role: "SMOKE" | "REGRESSION" | "HOLDOUT" | "STRESS";
  workload: "BUGFIX";
  risk: "STANDARD" | "CRITICAL";
  component: string;
  exposure:
    "KNOWN_TO_AUTHORS" | "USED_FOR_TUNING" | "UNTOUCHED_HOLDOUT" | "UNKNOWN";
  pass_to_pass_test_ids: string[];
  fail_to_pass_test_ids: string[];
  allowed_source_prefixes: string[];
  calibration_artifacts: ArtifactRef[];
  qualified_by: string | null;
  quarantine_reasons: string[];
}
export interface ScheduledAttempt {
  task_id: string;
  release_id: string;
  repeat: 1 | 2;
  block_id: string;
  order: number;
}
export interface Comparison {
  kind: "Comparison";
  schema_version: 1;
  id: string;
  repository_id: string;
  candidate_pr: number;
  candidate_head_sha: string;
  baseline_source_sha: string;
  benchmark_source_sha: string;
  controller_commit_sha: string;
  current_release_digest: string;
  candidate_release_digest: string;
  benchmark_digest: string;
  policy_digest: string;
  created_at: string;
  trigger_actor: string;
  github_actions_run_id: string;
  evidence_maturity: "PIPELINE_DEMO" | "EXPLORATORY_REPLAY";
  schedule: ScheduledAttempt[];
  release_decision: "NOT_QUALIFIED_FOR_PRODUCTION";
}
export interface Run {
  kind: "Run";
  schema_version: 1;
  id: string;
  comparison_id: string;
  task_digest: string;
  release_digest: string;
  block_id: string;
  repeat: 1 | 2;
  started_at: string;
  finished_at: string;
  outcome: Outcome;
  phase: "SETUP" | "AGENT" | "CAPTURE" | "BUILD" | "VERIFY" | "COMPLETE";
  reason: string;
  checks: {
    test_id: string;
    group: "PASS_TO_PASS" | "FAIL_TO_PASS";
    outcome: "PASS" | "FAIL" | "SKIP" | "ERROR";
    evidence_artifact_id: string;
  }[];
  agent_duration_ms: number | null;
  total_duration_ms: number;
  usage: Usage | null;
  estimated_model_cost: number | null;
  rate_record_artifact_id: string | null;
  artifacts: ArtifactRef[];
  environment_ids: string[];
  cleanup_status: "CONFIRMED" | "PENDING" | "FAILED";
  replaces_run_id: string | null;
}
export type FrozenRecord = HarnessRelease | Task | Comparison | Run;
let validator: ReturnType<Ajv2020["compile"]> | undefined;
export function validateRecord<T extends FrozenRecord>(record: T): T {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    (addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
    validator = ajv.compile(
      JSON.parse(
        readFileSync(
          resolve("prd/fullbeam-instacloud-prd/record-contracts.schema.json"),
          "utf8",
        ),
      ),
    );
  }
  if (!validator(record))
    throw new Error(
      `Invalid ${record.kind}: ${JSON.stringify(validator.errors)}`,
    );
  if (
    "digest" in record &&
    recordDigest(record as unknown as Record<string, unknown>) !== record.digest
  )
    throw new Error("Record digest mismatch");
  if (record.kind === "Task") {
    const ids = [
      ...record.pass_to_pass_test_ids,
      ...record.fail_to_pass_test_ids,
    ];
    if (new Set(ids).size !== ids.length)
      throw new Error("Overlapping or duplicate checks");
    if (
      record.quality_tier === "GOLD" &&
      (!record.qualified_by ||
        record.calibration_artifacts.length < 6 ||
        record.disposition !== "ACTIVE" ||
        record.quarantine_reasons.length)
    )
      throw new Error(
        "GOLD requires approved calibration and active disposition",
      );
  }
  if (record.kind === "Run") {
    if (Date.parse(record.finished_at) < Date.parse(record.started_at))
      throw new Error("Invalid run time ordering");
    if (
      record.estimated_model_cost !== null &&
      (!record.usage?.complete || !record.rate_record_artifact_id)
    )
      throw new Error("Unaccounted model cost");
    if (
      record.outcome === "PASS" &&
      (!record.checks.length || record.checks.some((c) => c.outcome !== "PASS"))
    )
      throw new Error("PASS requires observed passing checks");
  }
  return record;
}
export function freezeRecord<T extends HarnessRelease | Task>(
  record: Omit<T, "digest">,
): T {
  const result = {
    ...record,
    digest: recordDigest(record as Record<string, unknown>),
  } as T;
  return validateRecord(result);
}
