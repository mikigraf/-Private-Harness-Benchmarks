import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GitHubClient, freezeSourceTree } from "../github/index.js";
import {
  type Config,
  DEFAULT_POLICY,
  redact,
  secretsOf,
} from "../core/config.js";
import { EvidenceStore, type ArtifactRef } from "../core/store.js";
import {
  digest,
  manifestDigest,
  overlayFiles,
  validateSubmittedFiles,
  recordDigest,
  sha256,
} from "../core/integrity.js";
import {
  validateRecord,
  type Task,
  type Comparison,
  type Run,
} from "../core/records.js";
import {
  resolveHarnessForComparison,
  classifyHarnessChange,
  isHarnessPath,
  type ComparisonResolvedHarness,
} from "../harness/resolve.js";
import {
  classifyVerification,
  summarize,
  measuredUsage,
  estimateCost,
  type Outcome,
} from "../comparison/summarize.js";
import {
  resolveModelRate,
  type ModelRateRecord,
} from "../comparison/pricing.js";
import { sourcePatchDigest } from "../benchmark/source-patch.js";
import { evaluateCalibration } from "../benchmark/qualify.js";
import { github, defaultHead, readRepoJson } from "./github-context.js";
import { fromGitFiles } from "./files.js";
import { graderBundle } from "./grader.js";
import { RemoteController } from "./remote.js";
import { buildSchedule } from "./schedule.js";
import { reportHash } from "./report.js";
import { assertTaskQualification } from "./qualification.js";
import type {
  RuntimeLock,
  BenchmarkLock,
  TaskPackage,
  Slot,
  RunEnvelope,
  PublishedReport,
} from "./types.js";
import { uploadEvidence } from "../core/checkpoints.js";

export const GENERATION_SUBMISSION_POLICY = [
  "Fullbeam execution and submission policy:",
  `Only edit source files under ${DEFAULT_POLICY.allow_source_prefixes.join(" or ")}.`,
  "Existing public tests under tests/public/ are protected: run them, but do not edit, delete, rename, or replace them. Put any new or modified agent-authored tests under tests/agent/ and run those tests explicitly when needed.",
  "All other supplied files are protected, including README.md, package.json, package-lock.json, tsconfig.json, skills.md, .codex/, and .agents/. Every AGENTS.md is protected, including nested files under src/.",
  "Use the installed dependencies and existing public build/test commands. Do not change dependency manifests, harness instructions, or evaluation infrastructure. Changes to protected inputs invalidate the submission even if the application fix is correct.",
].join("\n");

export function generationPrompt(taskPrompt: string): string {
  return `${GENERATION_SUBMISSION_POLICY}\n\nOriginal issue (verbatim):\n${taskPrompt}`;
}

async function qualifiedPackages(
  client: GitHubClient,
  benchmark: BenchmarkLock,
  ref: string,
  runtime: RuntimeLock,
  verifier: string,
): Promise<TaskPackage[]> {
  const packages: TaskPackage[] = [];
  if (
    benchmark.policy_digest !== digest(DEFAULT_POLICY) ||
    benchmark.runtime_digest !== runtime.application_digest
  )
    throw new Error("Benchmark policy/runtime changed: recalibration required");
  for (const entry of benchmark.tasks) {
    if (entry.path !== `.fullbeam/private/tasks/${entry.id}.json`)
      throw new Error("Invalid benchmark task path");
    const p = await readRepoJson<TaskPackage>(client, entry.path, ref);
    validateRecord(p.task);
    if (
      p.task.digest !== entry.digest ||
      p.task.repository_id !== benchmark.repository_id ||
      p.task.disposition !== "ACTIVE"
    )
      throw new Error("Task is not a current qualified member");
    assertTaskQualification(p, benchmark);
    if (
      digest(p.issue_snapshot) !== p.task.issue_snapshot_sha256 ||
      p.prompt !== `${p.issue_snapshot.title}\n\n${p.issue_snapshot.body}`
    )
      throw new Error("Prompt snapshot integrity mismatch");
    if (
      !p.approval ||
      p.approval.task_digest !== p.task.digest ||
      p.approval.subject_digest !== digest(p.subject)
    )
      throw new Error("Qualification approval binding mismatch");
    if (
      p.task.verifier_sha256 !== verifier ||
      p.subject.verifier_digest !== verifier ||
      p.task.verifier_image_digest !== runtime.images.verification ||
      p.subject.runtime_digest !== runtime.application_digest
    )
      throw new Error("Verifier/runtime changed: recalibration required");
    if (
      sourcePatchDigest(p.source, p.reference) !== p.task.reference_patch_sha256
    )
      throw new Error("Reference patch integrity mismatch");
    if (
      manifestDigest(p.source) !== p.task.source_bundle_sha256 ||
      manifestDigest(p.source) !== p.subject.source_digest ||
      manifestDigest(p.reference) !== p.subject.reference_digest ||
      manifestDigest(p.mutant) !== p.subject.mutant_digest
    )
      throw new Error("Qualification source integrity mismatch");
    const evaluated = evaluateCalibration(
      digest(p.subject),
      p.subject.expected_ids,
      p.controls,
    );
    if (
      !evaluated.qualified ||
      digest(evaluated.passToPass) !== digest(p.task.pass_to_pass_test_ids) ||
      digest(evaluated.failToPass) !== digest(p.task.fail_to_pass_test_ids)
    )
      throw new Error("Invalid calibration observations");
    if (
      digest(p.approval.control_digests) !==
      digest(p.task.calibration_artifacts.map((a) => a.sha256))
    )
      throw new Error("Calibration approval artifact mismatch");
    for (let i = 0; i < p.task.calibration_artifacts.length; i++) {
      const a = p.task.calibration_artifacts[i]!;
      const observed = await readRepoJson<any>(
        client,
        `.fullbeam/private/artifacts/${a.id}.json`,
        ref,
      );
      if (
        !observed.integrityVerified ||
        !["COMPLETED", "FUNCTIONAL_FAIL"].includes(observed.status) ||
        !Array.isArray(observed.violations) ||
        observed.violations.length
      )
        throw new Error("Invalid calibration execution evidence");
      if (
        digest(observed) !== a.sha256 ||
        digest(observed.checks) !== digest(p.controls[i]!.checks) ||
        observed.buildPassed !== p.controls[i]!.buildPassed ||
        observed.startupPassed !== p.controls[i]!.startupPassed
      )
        throw new Error("Calibration artifact integrity mismatch");
    }
    packages.push(p);
  }
  if (
    !packages.length ||
    new Set(packages.map((p) => p.task.id)).size !== packages.length
  )
    throw new Error("Benchmark must have distinct qualified tasks");
  return packages;
}

export async function compare(
  config: Config,
  prNumber: number,
  benchmarkSha: string,
  trigger: string,
  previous: string | null,
  expectedHeadSha: string,
): Promise<PublishedReport> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new Error("Candidate PR must be a positive integer");
  const client0 = github(config);
  const repo = await defaultHead(client0);
  if (!repo.private)
    throw new Error("P0 evaluation requires an owned private repository");
  const client = github(config, config.repository, repo.id);
  const pull = await client.rest<{
    head: { sha: string; repo: { id: number } | null };
    base: { sha: string; ref: string; repo: { id: number } };
    user: { login: string };
  }>("GET", `pulls/${prNumber}`);
  if (pull.head.sha !== expectedHeadSha)
    throw new Error("Candidate head changed before comparison intake");
  if (pull.head.repo?.id !== repo.id || pull.base.repo.id !== repo.id)
    throw new Error("Fork or cross-repository harness PR is outside P0");
  if (pull.base.ref !== repo.branch)
    throw new Error("Candidate PR must target the protected default branch");
  const changed = await client.paginate<{
    filename: string;
    previous_filename?: string;
  }>(`pulls/${prNumber}/files`, { per_page: 100 });
  if (
    !changed.length ||
    changed.some(
      (f) =>
        !isHarnessPath(f.filename) ||
        (f.previous_filename && !isHarnessPath(f.previous_filename)),
    )
  )
    throw new Error(
      "Harness-only comparison rejected mixed application/controller/benchmark changes",
    );
  const afterFiles = await client.rest<{
    head: { sha: string };
    base: { sha: string; ref: string };
  }>("GET", `pulls/${prNumber}`);
  if (
    afterFiles.head.sha !== pull.head.sha ||
    afterFiles.base.sha !== pull.base.sha ||
    afterFiles.base.ref !== pull.base.ref
  )
    throw new Error("PR changed while binding its changed-file evidence");
  const runtime = await readRepoJson<RuntimeLock>(
    client,
    ".fullbeam/runtime.lock.json",
    benchmarkSha,
  );
  if (runtime.capability.status !== "READY")
    throw new Error("Runtime has not passed mandatory preflight");
  const benchmark = await readRepoJson<BenchmarkLock>(
    client,
    ".fullbeam/benchmark.lock.json",
    benchmarkSha,
  );
  if (benchmark.repository_id !== String(repo.id))
    throw new Error("Benchmark belongs to a different repository");
  const grader = await graderBundle();
  const packages = await qualifiedPackages(
    client,
    benchmark,
    benchmarkSha,
    runtime,
    grader.verifierSha256,
  );
  const releases = {} as {
    current: ComparisonResolvedHarness;
    candidate: ComparisonResolvedHarness;
  };
  for (const [side, sha] of [
    ["current", pull.base.sha],
    ["candidate", pull.head.sha],
  ] as const) {
    const tree = await freezeSourceTree(client, sha, {
      allowPath: isHarnessPath,
    });
    releases[side] = resolveHarnessForComparison(
      fromGitFiles(tree.files.filter((f) => isHarnessPath(f.path))),
      sha,
      {
        generation: runtime.images.generation,
        application: runtime.application_digest,
      },
      side,
    );
  }
  const modelSettings = (harness: ComparisonResolvedHarness) => ({
    model: harness.release.requested_model,
    reasoning_effort:
      typeof harness.settings.model_reasoning_effort === "string"
        ? harness.settings.model_reasoning_effort
        : null,
  });
  const configurationChange = {
    classification: classifyHarnessChange(releases.current, releases.candidate),
    current: modelSettings(releases.current),
    candidate: modelSettings(releases.candidate),
  };
  const comparisonId = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${randomUUID().slice(0, 8)}`;
  const seed = digest({ trigger, comparisonId });
  const slots = buildSchedule(
    comparisonId,
    packages.map((p) => p.task),
    {
      current: releases.current.release,
      candidate: releases.candidate.release,
    },
    seed,
  );
  const comparison: Comparison = validateRecord({
    kind: "Comparison",
    schema_version: 1,
    id: comparisonId,
    repository_id: String(repo.id),
    candidate_pr: prNumber,
    candidate_head_sha: pull.head.sha,
    baseline_source_sha: pull.base.sha,
    benchmark_source_sha: benchmarkSha,
    controller_commit_sha: benchmarkSha,
    current_release_digest: releases.current.release.digest,
    candidate_release_digest: releases.candidate.release.digest,
    benchmark_digest: digest(benchmark),
    policy_digest: benchmark.policy_digest,
    created_at: new Date().toISOString(),
    trigger_actor: process.env.GITHUB_ACTOR ?? "local-unpublished",
    github_actions_run_id: process.env.GITHUB_RUN_ID ?? "local-unpublished",
    evidence_maturity: "PIPELINE_DEMO",
    schedule: slots.map((s) => ({
      task_id: s.task_id,
      release_id: s.release_id,
      repeat: s.repeat,
      block_id: s.block_id,
      order: s.order,
    })),
    release_decision: "NOT_QUALIFIED_FOR_PRODUCTION",
  });
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  await store.immutable(
    `comparisons/${comparisonId}/comparison.json`,
    comparison,
  );
  await store.immutable(`comparisons/${comparisonId}/schedule.json`, {
    seed,
    slots,
    previous,
    trigger,
  });
  const artifacts = [
    await store.putJson(releases.current),
    await store.putJson(releases.candidate),
  ];
  const modelRates = new Map<
    string,
    { record: ModelRateRecord; artifact: ArtifactRef }
  >();
  for (const harness of Object.values(releases)) {
    const model = harness.release.requested_model;
    if (modelRates.has(model)) continue;
    const record = resolveModelRate(config, model);
    if (record)
      modelRates.set(model, { record, artifact: await store.putJson(record) });
  }
  await uploadEvidence(store, `fullbeam-plan-${comparisonId}`);
  const remote = new RemoteController(config, runtime, store, comparisonId);
  await remote.initialize();
  const concurrency =
    config.maxCost === null ? DEFAULT_POLICY.max_parallel_pipelines : 1;
  const workers = Array.from({ length: concurrency }, () => remote.fork());
  const runs: RunEnvelope[] = [];
  let spent = 0,
    cleanup = true,
    allocationBlocked = false;
  const executeSlot = async (slot: Slot, worker: RemoteController) => {
    await store.immutable(
      `comparisons/${comparisonId}/planned/${slot.order}.json`,
      slot,
    );
    const start = new Date().toISOString();
    const task = packages.find((p) => p.task.id === slot.task_id)!;
    const release = releases[slot.release_id];
    const run: Run = {
      kind: "Run",
      schema_version: 1,
      id: slot.id,
      comparison_id: comparisonId,
      task_digest: slot.task_digest,
      release_digest: slot.release_digest,
      block_id: slot.block_id,
      repeat: slot.repeat,
      started_at: start,
      finished_at: start,
      outcome: "INFRA_ERROR",
      phase: "SETUP",
      reason: "Attempt started",
      checks: [],
      agent_duration_ms: null,
      total_duration_ms: 0,
      usage: null,
      estimated_model_cost: null,
      rate_record_artifact_id: null,
      artifacts: [],
      environment_ids: [],
      cleanup_status: "PENDING",
      replaces_run_id: null,
    };
    console.log(
      `Attempt ${slot.order + 1}/${slots.length}: ${slot.task_id} ${slot.release_id} ${slot.repeat}/2`,
    );
    try {
      if (process.exitCode === 130) {
        run.outcome = "CANCELLED";
        run.reason = "Controller cancellation";
      } else if (allocationBlocked) {
        run.outcome = "CANCELLED";
        run.reason =
          "Unconfirmed resource cleanup; no further allocation permitted";
      } else if (release.configurationError) {
        run.outcome = "CANDIDATE_CONFIG_ERROR";
        run.reason = release.configurationError;
      } else if (config.maxCost !== null && spent >= config.maxCost) {
        run.outcome = "CANCELLED";
        run.reason =
          "Declared measured spending threshold reached; no further scheduling";
      } else {
        const files = overlayFiles(task.source, release.files);
        const prompt = generationPrompt(task.prompt);
        const inputPath = `comparisons/${comparisonId}/inputs/${slot.order}.json`;
        const recordedInput = {
          schema_version: 1,
          slot_id: slot.id,
          task_digest: task.task.digest,
          task_prompt_sha256: sha256(task.prompt),
          policy_sha256: sha256(GENERATION_SUBMISSION_POLICY),
          prompt,
          prompt_sha256: sha256(prompt),
        };
        await store.immutable(inputPath, recordedInput);
        if (process.exitCode === 130 || allocationBlocked) {
          run.outcome = "CANCELLED";
          run.reason = allocationBlocked
            ? "Unconfirmed resource cleanup; no further allocation permitted"
            : "Controller cancellation before generation allocation";
          return;
        }
        run.phase = "AGENT";
        const gen = await worker.execute(`${slot.id}-generation`, files, {
          role: "generation",
          prompt,
          model: release.release.requested_model,
          reasoningEffort:
            typeof release.settings.model_reasoning_effort === "string"
              ? release.settings.model_reasoning_effort
              : undefined,
          timeoutSeconds: 240,
          nativeVersion: runtime.codex_version,
          allowedWritePaths: [...DEFAULT_POLICY.allow_source_prefixes],
          protectedPaths: files
            .filter((f) => !f.path.startsWith("src/") || isHarnessPath(f.path))
            .map((f) => f.path),
        });
        if (gen.cleanup === "FAILED") {
          cleanup = false;
          allocationBlocked = true;
        }
        run.environment_ids.push(
          gen.environment.providerId ??
            `${gen.environment.projectId}/${gen.environment.branch}`,
        );
        run.agent_duration_ms = gen.result.agentDurationMs ?? null;
        run.usage = measuredUsage(gen.result);
        const rate = modelRates.get(release.release.requested_model);
        run.estimated_model_cost = estimateCost(
          run.usage,
          rate
            ? {
                input: rate.record.input,
                cached: rate.record.cached,
                output: rate.record.output,
              }
            : null,
        );
        if (run.estimated_model_cost !== null) {
          run.rate_record_artifact_id = rate!.artifact.id;
          spent += run.estimated_model_cost;
        }
        const captured = {
          ...gen.result,
          controllerInput: { path: inputPath, sha256: digest(recordedInput) },
          events: redact(gen.result.events, secretsOf(config)),
          stderr: redact(gen.result.stderr, secretsOf(config)),
        };
        run.artifacts.push(await store.putJson(captured));
        const ordered = (rows: unknown[]) =>
          [...rows].sort((a: any, b: any) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          );
        if (
          digest(ordered(gen.result.beforeManifest)) !==
          digest(ordered(files.map(({ content, ...f }) => f)))
        )
          throw new Error(
            "Materialized generation source/harness differs from frozen input",
          );
        run.phase = "CAPTURE";
        const output = validateSubmittedFiles(files, gen.result.files);
        if (gen.cleanup === "FAILED") {
          run.outcome = "INFRA_ERROR";
          run.reason =
            "Generation cleanup unconfirmed; independent verification was not allocated";
        } else if (output.violations.length || gen.result.violations.length) {
          run.outcome = "POLICY_VIOLATION";
          run.reason = `Protected output changed: ${[...output.violations, ...gen.result.violations].join(", ")}`;
        } else if (gen.result.status === "AGENT_TIMEOUT") {
          run.outcome = "AGENT_TIMEOUT";
          run.reason = "Agent execution budget expired";
        } else if (gen.result.status === "INFRA_ERROR") {
          run.outcome = "INFRA_ERROR";
          run.reason =
            "Remote supervisor could not capture valid generation evidence";
        } else if (gen.result.status === "CANDIDATE_CONFIG_ERROR") {
          run.outcome = "CANDIDATE_CONFIG_ERROR";
          run.reason = "Frozen native configuration could not initialize";
        } else if (gen.result.status === "AGENT_ERROR") {
          const diagnostic = gen.result.stderr + "\n" + gen.result.events;
          run.outcome =
            /model_not_found|unsupported model|invalid.*config|required.*tool.*fail/i.test(
              diagnostic,
            )
              ? "CANDIDATE_CONFIG_ERROR"
              : "INFRA_ERROR";
          run.reason =
            run.outcome === "CANDIDATE_CONFIG_ERROR"
              ? "Required native model/configuration failed"
              : "Native agent failed with ambiguous attribution; evidence incomplete";
        } else if (allocationBlocked) {
          run.outcome = "CANCELLED";
          run.reason =
            "Peer resource cleanup unconfirmed; independent verification was not allocated";
        } else if (process.exitCode === 130) {
          run.outcome = "CANCELLED";
          run.reason =
            "Controller cancellation before independent verification";
        } else {
          run.phase = "VERIFY";
          const submission = [
            ...task.source.filter((f) => !f.path.startsWith("src/")),
            ...output.source,
          ];
          const graded = await worker.execute(
            `${slot.id}-verification`,
            submission,
            {
              role: "verification",
              taskId: task.task.id,
              timeoutSeconds: 120,
              ...grader,
            },
          );
          if (graded.cleanup === "FAILED") {
            cleanup = false;
            allocationBlocked = true;
          }
          run.environment_ids.push(
            graded.environment.providerId ??
              `${graded.environment.projectId}/${graded.environment.branch}`,
          );
          const evidence = await store.putJson(graded.result);
          run.artifacts.push(evidence);
          run.checks = graded.result.checks.map((c) => ({
            test_id: c.id,
            group: task.task.pass_to_pass_test_ids.includes(c.id)
              ? "PASS_TO_PASS"
              : "FAIL_TO_PASS",
            outcome: c.status,
            evidence_artifact_id: evidence.id,
          }));
          run.outcome = classifyVerification(
            task.task.pass_to_pass_test_ids,
            task.task.fail_to_pass_test_ids,
            graded.result,
          );
          run.reason =
            run.outcome === "PASS"
              ? "All expected independent behavioral checks passed"
              : run.outcome === "POLICY_VIOLATION"
                ? "Submitted application modified protected verifier inputs"
                : run.outcome === "INFRA_ERROR"
                  ? "Independent verification evidence was missing, malformed or invalid"
                  : !graded.result.buildPassed || !graded.result.startupPassed
                    ? "Submitted source failed compilation or service startup"
                    : "Independent behavioral assertions failed";
        }
      }
    } catch (error) {
      run.outcome = process.exitCode === 130 ? "CANCELLED" : "INFRA_ERROR";
      run.reason = redact(String(error), secretsOf(config));
    } finally {
      let cleaned = false;
      try {
        cleaned = await worker.cleanup();
      } catch (error) {
        if (run.outcome !== "CANCELLED") run.outcome = "INFRA_ERROR";
        run.reason += `; resource cleanup could not be confirmed: ${redact(String(error), secretsOf(config))}`;
      }
      cleanup &&= cleaned;
      if (!cleaned) allocationBlocked = true;
      run.cleanup_status = cleaned ? "CONFIRMED" : "FAILED";
      run.finished_at = new Date().toISOString();
      run.total_duration_ms =
        Date.parse(run.finished_at) - Date.parse(run.started_at);
      if (run.outcome === "PASS") run.phase = "COMPLETE";
      validateRecord(run);
      runs.push({ slot, run });
      await store.immutable(
        `comparisons/${comparisonId}/runs/${slot.order}.json`,
        { slot, run },
      );
    }
  };
  try {
    for (let offset = 0; offset < slots.length; offset += concurrency) {
      const wave = slots.slice(offset, offset + concurrency);
      const completed = await Promise.allSettled(
        wave.map((slot, index) => executeSlot(slot, workers[index]!)),
      );
      // All resource activity has stopped before taking a complete evidence snapshot.
      // Individual immutable resource events remain checkpointed during each attempt.
      for (let index = 0; index < wave.length; index++) {
        if (completed[index]!.status === "fulfilled")
          await uploadEvidence(
            store,
            `fullbeam-attempt-${comparisonId}-${wave[index]!.order}`,
          );
      }
      const failure = completed.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  } finally {
    const closed = await Promise.allSettled(
      workers.map((worker) => worker.close()),
    );
    try {
      const finalCleanup = await remote.cleanup();
      cleanup = cleanup && finalCleanup;
    } finally {
      await remote.close();
    }
    const failure = closed.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  runs.sort((a, b) => a.slot.order - b.slot.order);
  const summary = summarize(
    packages.map((p) => ({
      id: p.task.id,
      risk: p.task.risk,
      current: runs
        .filter(
          (r) =>
            r.slot.task_id === p.task.id && r.slot.release_id === "current",
        )
        .map((r) => r.run.outcome),
      candidate: runs
        .filter(
          (r) =>
            r.slot.task_id === p.task.id && r.slot.release_id === "candidate",
        )
        .map((r) => r.run.outcome),
    })),
  );
  const fresh = await client.rest<{ head: { sha: string } }>(
    "GET",
    `pulls/${prNumber}`,
  );
  const coverage = runs.filter(
    (r) => r.run.estimated_model_cost !== null,
  ).length;
  const successes = runs.filter((r) => r.run.outcome === "PASS").length;
  const report: PublishedReport = {
    schema_version: 1,
    comparison,
    comparison_digest: digest(comparison),
    configuration_change: configurationChange,
    slots,
    runs,
    summary,
    cleanup_status: cleanup ? "CONFIRMED" : "FAILED",
    applicability:
      fresh.head.sha === comparison.candidate_head_sha ? "CURRENT" : "OUTDATED",
    limitations: [
      ...new Set(
        [...modelRates.values()].flatMap(({ record }) => record.limitations),
      ),
      ...(configurationChange.classification === "BUNDLE"
        ? [
            "BUNDLE changes both model settings and harness files/settings; this comparison cannot attribute a difference to either component alone.",
          ]
        : []),
      benchmark.dataset_card.qualification_mode === "AUTOMATED_DEMO"
        ? "AUTOMATED_DEMO: calibrated SILVER fixtures; seed and qualification checks were automated, with no human review or GOLD claim."
        : "Human-reviewed GOLD calibration; the overall result remains a seeded pipeline demonstration.",
      "Owned seeded SMOKE tasks are known to authors; no customer workload or holdout claim.",
      "Outbound egress restrictions, exact cloud billing attribution and provider TTL are UNKNOWN.",
      "Native component exposure/use is UNKNOWN unless direct trace evidence is retained.",
      config.maxCost === null
        ? `Runtime uses up to ${concurrency} pipelines with fresh generation and verification environments; full attempt snapshots wait for both scheduled peers.`
        : "Runtime uses one pipeline because a measured cost ceiling is configured, with fresh generation and verification environments.",
    ],
    previous_comparison_id: previous,
    created_at: new Date().toISOString(),
    report_hash: "",
    cost: {
      measured_usd: spent,
      coverage,
      cost_per_success:
        coverage === slots.length && successes > 0 ? spent / successes : null,
      instacloud_cost: null,
    },
    artifacts,
  };
  report.report_hash = reportHash(report);
  await store.immutable(`comparisons/${comparisonId}/report.json`, report);
  return report;
}
