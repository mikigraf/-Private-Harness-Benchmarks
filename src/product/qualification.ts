import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GitHubIntake } from "../github/index.js";
import { type Config, DEFAULT_POLICY } from "../core/config.js";
import { EvidenceStore } from "../core/store.js";
import {
  digest,
  manifestDigest,
  overlayFiles,
  sha256,
  type FileEntry,
} from "../core/integrity.js";
import { freezeRecord, type Task } from "../core/records.js";
import {
  evaluateCalibration,
  type CalibrationControl,
  type QualificationSubject,
} from "../benchmark/qualify.js";
import {
  seedTasks,
  mutantFiles,
  expectedCheckIds,
} from "../benchmark/relaydesk.js";
import {
  replaceSourceSubtree,
  sourcePatchDigest,
} from "../benchmark/source-patch.js";
import { github, defaultHead, readRepoJson } from "./github-context.js";
import { APPLICATION_PATHS, fromGitFiles } from "./files.js";
import { graderBundle } from "./grader.js";
import { RemoteController } from "./remote.js";
import type { ArtifactManifest } from "../execution/types.js";
import type {
  BenchmarkLock,
  DemoState,
  QualificationMode,
  RuntimeLock,
  TaskPackage,
} from "./types.js";
export interface QualificationOutput {
  schema_version: 1;
  repository_id: string;
  source_commit: string;
  runtime: RuntimeLock;
  policy_digest: string;
  packages: TaskPackage[];
  artifact_objects: Record<string, unknown>;
  actions_run_id: string;
  approval_digest: string;
}

/** Finalize already validated calibration without inventing human review. */
export function finalizeQualificationPackage(
  pending: TaskPackage,
  mode: QualificationMode,
  actor: string,
  at: string,
): TaskPackage {
  if (!actor.trim() || !Number.isFinite(Date.parse(at)) || pending.approval)
    throw new Error(
      "Qualification requires an actor, timestamp, and pending package",
    );
  const taskPackage = structuredClone(pending);
  const { digest: _oldDigest, ...task } = taskPackage.task;
  taskPackage.task = freezeRecord<Task>({
    ...task,
    quality_tier: mode === "HUMAN" ? "GOLD" : "SILVER",
    qualified_by: mode === "HUMAN" ? actor : null,
  });
  taskPackage.approval = {
    mode,
    actor,
    at,
    subject_digest: digest(taskPackage.subject),
    task_digest: taskPackage.task.digest,
    control_digests: taskPackage.task.calibration_artifacts.map(
      (artifact) => artifact.sha256,
    ),
  };
  return taskPackage;
}

/** SILVER admission is confined to explicit, known owned SMOKE demos. */
export function assertTaskQualification(
  taskPackage: TaskPackage,
  benchmark: BenchmarkLock,
): void {
  const { task, approval, subject } = taskPackage;
  const mode = benchmark.dataset_card.qualification_mode ?? "HUMAN";
  if (
    task.repository_id !== benchmark.repository_id ||
    task.disposition !== "ACTIVE" ||
    task.quarantine_reasons.length ||
    !approval ||
    !approval.actor.trim() ||
    (approval.mode ?? "HUMAN") !== mode ||
    approval.task_digest !== task.digest ||
    approval.subject_digest !== digest(subject)
  )
    throw new Error("Qualification approval binding mismatch");
  if (mode === "AUTOMATED_DEMO") {
    const seeded = seedTasks.find((candidate) => candidate.id === task.id);
    if (
      !seeded ||
      benchmark.dataset_card.origin !== "SEEDED_DEMO" ||
      benchmark.dataset_card.suite !== "SMOKE" ||
      benchmark.dataset_card.exposure !== "KNOWN_TO_AUTHORS" ||
      !benchmark.dataset_card.selection.includes(task.id) ||
      task.origin !== "SEEDED_DEMO" ||
      task.visibility !== "PRIVATE" ||
      task.suite_role !== "SMOKE" ||
      task.exposure !== "KNOWN_TO_AUTHORS" ||
      task.history_fidelity !== "SNAPSHOT_BEFORE_SOLUTION" ||
      task.risk !== seeded.risk ||
      task.component !== seeded.component ||
      task.quality_tier !== "SILVER" ||
      task.qualified_by !== null ||
      digest([...subject.expected_ids].sort()) !==
        digest(expectedCheckIds(task.id).sort()) ||
      digest(
        [...task.pass_to_pass_test_ids, ...task.fail_to_pass_test_ids].sort(),
      ) !== digest(expectedCheckIds(task.id).sort())
    )
      throw new Error(
        "Automated qualification is restricted to known SILVER seeded SMOKE tasks",
      );
  } else if (
    mode !== "HUMAN" ||
    task.quality_tier !== "GOLD" ||
    approval.actor !== task.qualified_by
  ) {
    throw new Error("Task requires explicit human GOLD qualification");
  }
  if (
    task.calibration_artifacts.length !== 6 ||
    digest(approval.control_digests) !==
      digest(task.calibration_artifacts.map((artifact) => artifact.sha256))
  )
    throw new Error("Calibration approval artifact mismatch");
}
export function assertQualificationControlResult(
  result: Pick<ArtifactManifest, "status" | "integrityVerified" | "violations">,
): void {
  if (
    !["COMPLETED", "FUNCTIONAL_FAIL"].includes(result.status) ||
    !result.integrityVerified ||
    result.violations.length
  )
    throw new Error(`Invalid qualification control result: ${result.status}`);
}
export async function qualify(
  config: Config,
  sourceCommit: string,
): Promise<QualificationOutput> {
  const client0 = github(config);
  const repo = await defaultHead(client0);
  const client = github(config, config.repository, repo.id);
  const state = await readRepoJson<DemoState>(
    client,
    ".fullbeam/demo-state.json",
    sourceCommit,
  );
  const runtime = await readRepoJson<RuntimeLock>(
    client,
    ".fullbeam/runtime.lock.json",
    sourceCommit,
  );
  const policy = await readRepoJson<typeof DEFAULT_POLICY>(
    client,
    ".fullbeam/policy.json",
    sourceCommit,
  );
  if (digest(policy) !== digest(DEFAULT_POLICY))
    throw new Error(
      "Unsupported policy revision; regenerate approved P0 policy",
    );
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  const remote = new RemoteController(
    config,
    runtime,
    store,
    `qualify-${process.env.GITHUB_RUN_ID ?? randomUUID()}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
  );
  await remote.initialize();
  const grader = await graderBundle();
  const packages: TaskPackage[] = [];
  const artifact_objects: Record<string, unknown> = {};
  try {
    for (const selected of seedTasks) {
      const item = state.items.find((t) => t.id === selected.id);
      if (!item?.pr || !item.merge_receipt)
        throw new Error(
          `Seed task ${selected.id} has no observed approved squash merge`,
        );
      console.log(`Qualifying ${selected.id}: importing GitHub provenance`);
      const pair = await new GitHubIntake(client).snapshotPair({
        issueNumber: item.issue,
        pullNumber: item.pr,
        seedMergeReceipt: item.merge_receipt,
      });
      if (
        Date.parse(item.issue_snapshot.captured_at) >
        Date.parse(pair.pullRequest.mergedAt)
      )
        throw new Error("Issue snapshot was not captured before the solution");
      const filter = (f: { path: string }) =>
        APPLICATION_PATHS.some(
          (p) => f.path === p || f.path.startsWith(`${p}/`),
        );
      const source = fromGitFiles(pair.history.baseSource.files.filter(filter));
      const accepted = fromGitFiles(
        pair.history.acceptedSource.files.filter(filter),
      );
      const reference = replaceSourceSubtree(source, accepted);
      const mutant = overlayFiles(source, await mutantFiles(selected.id));
      const lock = source.find((f) => f.path === "package-lock.json");
      if (!lock) throw new Error("Historical dependency lock missing");
      const subject: QualificationSubject = {
        task_id: selected.id,
        repository_id: String(repo.id),
        base_sha: pair.history.baseCommitSha,
        reference_sha: pair.history.acceptedCommitSha,
        source_digest: manifestDigest(source),
        reference_digest: manifestDigest(reference),
        mutant_digest: manifestDigest(mutant),
        verifier_digest: grader.verifierSha256,
        runtime_digest: runtime.application_digest,
        policy_digest: digest(policy),
        expected_ids: expectedCheckIds(selected.id),
      };
      const subjectDigest = digest(subject);
      const controls: CalibrationControl[] = [];
      const artifacts = [];
      for (const kind of ["base", "reference", "mutant"] as const)
        for (const repeat of [1, 2] as const) {
          console.log(`  ${kind} control ${repeat}/2`);
          const execution = await remote.execute(
            `${remote.runId}-${selected.id}-${kind}-${repeat}`,
            kind === "base"
              ? source
              : kind === "reference"
                ? reference
                : mutant,
            {
              role: "verification",
              taskId: selected.id,
              timeoutSeconds: policy.verifier_timeout_seconds,
              ...grader,
            },
          );
          const artifact = await store.putJson(execution.result);
          artifacts.push(artifact);
          artifact_objects[artifact.id] = execution.result;
          if (execution.cleanup !== "CONFIRMED")
            throw new Error("Calibration environment cleanup is not confirmed");
          assertQualificationControlResult(execution.result);
          controls.push({
            kind,
            repeat,
            subject_digest: subjectDigest,
            buildPassed: execution.result.buildPassed === true,
            startupPassed: execution.result.startupPassed === true,
            checks: execution.result.checks,
          });
        }
      const result = evaluateCalibration(
        subjectDigest,
        subject.expected_ids,
        controls,
      );
      const provenance = await store.putJson(pair);
      artifact_objects[provenance.id] = pair;
      if (!result.qualified)
        throw new Error(
          `Calibration rejected ${selected.id}: ${result.reasons.join(", ")}`,
        );
      const task = freezeRecord<Task>({
        kind: "Task",
        schema_version: 1,
        id: selected.id,
        repository_id: String(repo.id),
        repository_full_name: config.repository,
        issue_number: item.issue,
        pull_request_number: item.pr,
        issue_node_id: pair.issue.nodeId,
        pull_request_node_id: pair.pullRequest.nodeId,
        link_evidence_artifact: provenance,
        base_sha: subject.base_sha,
        reference_sha: subject.reference_sha,
        issue_snapshot_sha256: digest(item.issue_snapshot),
        prompt_cutoff: item.issue_snapshot.captured_at,
        source_bundle_sha256: subject.source_digest,
        reference_patch_sha256: sourcePatchDigest(source, reference),
        verifier_sha256: grader.verifierSha256,
        dependency_lock_sha256: lock.sha256,
        application_runtime_digest: runtime.application_digest,
        verifier_image_digest: runtime.images.verification,
        origin: "SEEDED_DEMO",
        visibility: "PRIVATE",
        quality_tier: "SILVER",
        disposition: "ACTIVE",
        history_fidelity: "SNAPSHOT_BEFORE_SOLUTION",
        suite_role: "SMOKE",
        workload: "BUGFIX",
        risk: selected.risk,
        component: selected.component,
        exposure: "KNOWN_TO_AUTHORS",
        pass_to_pass_test_ids: result.passToPass,
        fail_to_pass_test_ids: result.failToPass,
        allowed_source_prefixes: ["src/", "tests/agent/"],
        calibration_artifacts: artifacts,
        qualified_by: null,
        quarantine_reasons: [],
      });
      packages.push({
        schema_version: 1,
        task,
        prompt: `${item.issue_snapshot.title}\n\n${item.issue_snapshot.body}`,
        issue_snapshot: item.issue_snapshot,
        source,
        reference,
        mutant,
        subject,
        controls,
        approval: null,
      });
    }
    const payload = {
      schema_version: 1 as const,
      repository_id: String(repo.id),
      source_commit: sourceCommit,
      runtime,
      policy_digest: digest(policy),
      packages,
      artifact_objects,
      actions_run_id: process.env.GITHUB_RUN_ID ?? "",
      approval_digest: "",
    };
    const { approval_digest: ignored, ...subjectPayload } = payload;
    payload.approval_digest = digest(subjectPayload);
    return payload;
  } finally {
    await remote.cleanup();
    await remote.close();
  }
}
