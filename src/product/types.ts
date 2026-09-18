import type { FileEntry } from "../core/integrity.js";
import type { ArtifactRef } from "../core/store.js";
import type { Task, Comparison, Run } from "../core/records.js";
import type {
  CalibrationControl,
  QualificationSubject,
} from "../benchmark/qualify.js";
import type { CapabilityReport } from "../execution/types.js";
export type QualificationMode = "HUMAN" | "AUTOMATED_DEMO";
export interface RuntimeLock {
  schema_version: 1;
  projects: { generation: string; verification: string };
  images: { generation: string; verification: string };
  application_digest: string;
  region: string;
  cli_version: string;
  codex_version: string;
  capability: CapabilityReport;
  created_at: string;
}
export interface SeedItem {
  id: string;
  issue: number;
  issue_snapshot: {
    title: string;
    body: string;
    updated_at: string;
    captured_at: string;
  };
  pr?: number;
  head?: string;
  branch?: string;
  approved_by?: string;
  review_mode?: QualificationMode;
  review_evidence?: ArtifactRef;
  merge_receipt?: {
    pullNumber: number;
    marker: string;
    headSha: string;
    mergeCommitSha: string;
    mergeMethod: "squash";
    approvedBy: string;
    reviewMode?: QualificationMode;
  };
  base?: string;
  reference?: string;
}
export interface DemoState {
  schema_version: 1;
  repository_id: number;
  repository: string;
  default_branch: string;
  items: SeedItem[];
  candidate_pr?: number;
  candidate_head?: string;
  qualified?: boolean;
  qualification_mode?: QualificationMode;
  last_run_id?: number;
}
export interface TaskPackage {
  schema_version: 1;
  task: Task;
  prompt: string;
  issue_snapshot: SeedItem["issue_snapshot"];
  source: FileEntry[];
  reference: FileEntry[];
  mutant: FileEntry[];
  subject: QualificationSubject;
  controls: CalibrationControl[];
  approval: {
    mode?: QualificationMode;
    actor: string;
    at: string;
    subject_digest: string;
    task_digest: string;
    control_digests: string[];
  } | null;
}
export interface BenchmarkLock {
  schema_version: 1;
  repository_id: string;
  policy_digest: string;
  runtime_digest: string;
  tasks: { id: string; digest: string; path: string }[];
  dataset_card: {
    origin: "SEEDED_DEMO";
    selection: string[];
    excluded: { id: string; reason: string }[];
    exposure: "KNOWN_TO_AUTHORS";
    suite: "SMOKE";
    qualification_mode?: QualificationMode;
  };
}
export interface Slot {
  id: string;
  task_id: string;
  task_digest: string;
  release_id: "current" | "candidate";
  release_digest: string;
  repeat: 1 | 2;
  block_id: string;
  order: number;
}
export interface RunEnvelope {
  slot: Slot;
  run: Run;
}
export interface PublishedReport {
  schema_version: 1;
  comparison: Comparison;
  comparison_digest: string;
  configuration_change?: {
    classification: ReturnType<
      typeof import("../harness/resolve.js").classifyHarnessChange
    >;
    current: { model: string; reasoning_effort: string | null };
    candidate: { model: string; reasoning_effort: string | null };
  };
  slots: Slot[];
  runs: RunEnvelope[];
  summary: ReturnType<typeof import("../comparison/summarize.js").summarize>;
  cleanup_status: "CONFIRMED" | "PENDING" | "FAILED";
  applicability: "CURRENT" | "OUTDATED";
  limitations: string[];
  previous_comparison_id: string | null;
  created_at: string;
  report_hash: string;
  cost: {
    measured_usd: number;
    coverage: number;
    cost_per_success: number | null;
    instacloud_cost: null;
  };
  artifacts: ArtifactRef[];
}
