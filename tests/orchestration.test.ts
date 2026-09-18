import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type Config } from "../src/core/config.js";
import {
  digest,
  makeFile,
  manifestDigest,
  sha256,
  type FileEntry,
} from "../src/core/integrity.js";
import { freezeRecord, type Task } from "../src/core/records.js";
import { EvidenceStore } from "../src/core/store.js";
import { parse as parseToml } from "@iarna/toml";
import { sourcePatchDigest } from "../src/benchmark/source-patch.js";
import { expectedCheckIds, seedTasks } from "../src/benchmark/relaydesk.js";
import type {
  TaskPackage,
  RuntimeLock,
  BenchmarkLock,
} from "../src/product/types.js";
import type { ArtifactManifest, AttemptInput } from "../src/execution/types.js";

const boundary = vi.hoisted(() => ({
  objects: new Map<string, unknown>(),
  execute: vi.fn(),
  malformedCandidate: false,
  mixed: false,
  baseBranch: "main",
  harnessFiles: new Map<string, FileEntry[]>(),
  controllerCount: 0,
  upload: vi.fn(),
  cleanup: vi.fn(),
}));
const baseSha = "a".repeat(40),
  headSha = "b".repeat(40),
  controllerSha = "c".repeat(40),
  verifierSha = "d".repeat(64);
vi.mock("../src/product/github-context.js", () => ({
  github: () => ({
    rest: async () => ({
      head: { sha: headSha, repo: { id: 42 } },
      base: { sha: baseSha, ref: boundary.baseBranch, repo: { id: 42 } },
    }),
    paginate: async () => [
      { filename: boundary.mixed ? "src/app.ts" : "AGENTS.md" },
    ],
  }),
  defaultHead: async () => ({
    id: 42,
    sha: controllerSha,
    branch: "main",
    private: true,
  }),
  readRepoJson: async (_client: unknown, path: string) => {
    if (!boundary.objects.has(path))
      throw new Error(`Missing simulated remote object: ${path}`);
    return boundary.objects.get(path);
  },
}));
vi.mock("../src/github/index.js", () => ({
  freezeSourceTree: async (_client: unknown, sha: string) => ({
    files: (
      boundary.harnessFiles.get(sha) ?? [
        makeFile(
          "AGENTS.md",
          sha === baseSha ? "Current instructions" : "Candidate instructions",
        ),
        makeFile(
          ".codex/config.toml",
          boundary.malformedCandidate && sha === headSha
            ? "model = ["
            : 'model = "test-model"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n',
        ),
      ]
    ).map((f) => ({ ...f, base64: f.content, mode: "100644" })),
  }),
}));
vi.mock("../src/product/grader.js", () => ({
  graderBundle: async () => ({
    verifierSha256: verifierSha,
    verifierModuleBase64: "aGlkZGVu",
  }),
}));
vi.mock("../src/core/checkpoints.js", () => ({
  uploadEvidence: (...args: unknown[]) => boundary.upload(...args),
}));
vi.mock("../src/product/remote.js", () => ({
  RemoteController: class MockRemoteController {
    instance = boundary.controllerCount++;
    fork() {
      return new MockRemoteController();
    }
    async initialize() {}
    async cleanup() {
      return boundary.cleanup(this.instance);
    }
    async close() {}
    execute = (id: string, files: FileEntry[], input: AttemptInput) =>
      boundary.execute(id, files, input, this.instance);
  },
}));
import {
  compare,
  generationPrompt,
  GENERATION_SUBMISSION_POLICY,
} from "../src/product/comparison.js";
import { renderReport } from "../src/product/report.js";

let config: Config;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function artifact(value: unknown) {
  const hash = digest(value);
  boundary.objects.set(`.fullbeam/private/artifacts/${hash}.json`, value);
  return { id: hash, sha256: hash, media_type: "application/json" };
}
function manifest(files: FileEntry[]) {
  return files.map(({ content: _, ...file }) => file);
}
function result(
  files: FileEntry[],
  role: "generation" | "verification",
): ArtifactManifest {
  return {
    executionId: "simulated-provider-boundary",
    role,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    agentDurationMs: role === "generation" ? 500 : null,
    status: "COMPLETED",
    exitCode: 0,
    files,
    beforeManifest: manifest(files),
    afterManifest: manifest(files),
    violations: [],
    events: JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    stderr: "",
    logsTruncated: false,
    usage: [],
    integrityVerified: true,
    buildPassed: true,
    startupPassed: true,
    checks: [
      { id: "owner", status: "PASS" },
      { id: "fixed", status: "PASS" },
    ],
  };
}
beforeEach(async () => {
  boundary.objects.clear();
  boundary.mixed = false;
  boundary.baseBranch = "main";
  boundary.malformedCandidate = false;
  boundary.harnessFiles.clear();
  boundary.controllerCount = 0;
  boundary.upload.mockReset().mockResolvedValue(undefined);
  boundary.cleanup.mockReset().mockResolvedValue(true);
  boundary.execute.mockReset();
  config = {
    githubToken: "test-github",
    repository: "test/fixture",
    demoRepository: "test/fixture",
    instacloudToken: "test-cloud",
    orgId: "test-org",
    region: "test-region",
    openaiKey: "test-model-key",
    model: "test-model",
    reasoningEffort: "medium",
    stateDir: await mkdtemp(join(tmpdir(), "fullbeam-orchestration-")),
    rates: { input: 1, cached: 1, output: 1 },
    maxCost: null,
  };
  const runtime = {
    schema_version: 1,
    projects: { generation: "gen", verification: "verify" },
    images: {
      generation: "gen@sha256:" + "1".repeat(64),
      verification: "verify@sha256:" + "2".repeat(64),
    },
    application_digest: "3".repeat(64),
    region: "test-region",
    cli_version: "0.0.83",
    codex_version: "0.125.0",
    capability: { status: "READY" },
    created_at: "2026-01-01T00:00:00Z",
  } as RuntimeLock;
  const benchmark = {
    schema_version: 1,
    repository_id: "42",
    policy_digest: digest(DEFAULT_POLICY),
    runtime_digest: runtime.application_digest,
    tasks: [],
    dataset_card: {
      origin: "SEEDED_DEMO",
      selection: [],
      excluded: [],
      exposure: "KNOWN_TO_AUTHORS",
      suite: "SMOKE",
    },
  } as BenchmarkLock;
  boundary.objects.set(".fullbeam/runtime.lock.json", runtime);
  for (const id of ["first", "second", "third"]) {
    const source = [
      makeFile("src/app.ts", "base"),
      makeFile("package-lock.json", "{}"),
    ];
    const reference = [makeFile("src/app.ts", "accepted"), source[1]!],
      mutant = [makeFile("src/app.ts", "mutant"), source[1]!];
    const snapshot = {
      title: `Fix ${id}`,
      body: "Original requirement, no solution.",
      captured_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    const subject = {
      task_id: id,
      repository_id: "42",
      base_sha: baseSha,
      reference_sha: headSha,
      source_digest: manifestDigest(source),
      reference_digest: manifestDigest(reference),
      mutant_digest: manifestDigest(mutant),
      verifier_digest: verifierSha,
      runtime_digest: runtime.application_digest,
      policy_digest: digest(DEFAULT_POLICY),
      expected_ids: ["owner", "fixed"],
    };
    const controls = (["base", "reference", "mutant"] as const).flatMap(
      (kind) =>
        ([1, 2] as const).map((repeat) => ({
          kind,
          repeat,
          subject_digest: digest(subject),
          buildPassed: true,
          startupPassed: true,
          checks: [
            { id: "owner", status: "PASS" as const },
            {
              id: "fixed",
              status:
                kind === "reference" ? ("PASS" as const) : ("FAIL" as const),
            },
          ],
        })),
    );
    const calibration = controls.map((c) =>
      artifact({
        ...result(source, "verification"),
        checks: c.checks,
        repeat: c.repeat,
        kind: c.kind,
      }),
    );
    const task = freezeRecord<Task>({
      kind: "Task",
      schema_version: 1,
      id,
      repository_id: "42",
      repository_full_name: config.repository,
      issue_number: 1,
      pull_request_number: 2,
      issue_node_id: "issue",
      pull_request_node_id: "pull",
      link_evidence_artifact: artifact({ simulated: true }),
      base_sha: baseSha,
      reference_sha: headSha,
      issue_snapshot_sha256: digest(snapshot),
      prompt_cutoff: snapshot.captured_at,
      source_bundle_sha256: manifestDigest(source),
      reference_patch_sha256: sourcePatchDigest(source, reference),
      verifier_sha256: verifierSha,
      dependency_lock_sha256: source[1]!.sha256,
      application_runtime_digest: runtime.application_digest,
      verifier_image_digest: runtime.images.verification,
      origin: "SEEDED_DEMO",
      visibility: "PRIVATE",
      quality_tier: "GOLD",
      disposition: "ACTIVE",
      history_fidelity: "SNAPSHOT_BEFORE_SOLUTION",
      suite_role: "SMOKE",
      workload: "BUGFIX",
      risk: "STANDARD",
      component: "fixture",
      exposure: "KNOWN_TO_AUTHORS",
      pass_to_pass_test_ids: ["owner"],
      fail_to_pass_test_ids: ["fixed"],
      allowed_source_prefixes: ["src/", "tests/agent/"],
      calibration_artifacts: calibration,
      qualified_by: "test-reviewer",
      quarantine_reasons: [],
    });
    const pkg: TaskPackage = {
      schema_version: 1,
      task,
      prompt: `${snapshot.title}\n\n${snapshot.body}`,
      issue_snapshot: snapshot,
      source,
      reference,
      mutant,
      subject,
      controls,
      approval: {
        actor: "test-reviewer",
        at: "2026-01-01T00:00:00Z",
        task_digest: task.digest,
        subject_digest: digest(subject),
        control_digests: calibration.map((a) => a.sha256),
      },
    };
    const path = `.fullbeam/private/tasks/${id}.json`;
    boundary.objects.set(path, pkg);
    benchmark.tasks.push({ id, path, digest: task.digest });
  }
  boundary.objects.set(".fullbeam/benchmark.lock.json", benchmark);
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => ({
      environment: { id, providerId: id },
      cleanup: "CONFIRMED",
      result: result(files, input.role),
    }),
  );
});
afterEach(async () => {
  await rm(config.stateDir, { recursive: true, force: true });
});
it("orchestrates and persists 12 distinct attempts with independent verification at simulated provider boundaries", async () => {
  const report = await compare(
    config,
    9,
    controllerSha,
    "test-trigger",
    null,
    headSha,
  );
  expect(report.runs).toHaveLength(12);
  expect(
    report.runs
      .filter(({ run }) => run.outcome === "INFRA_ERROR")
      .map(({ run }) => run.reason),
  ).toEqual([]);
  expect(report.summary.execution_completeness).toBe("COMPLETE");
  expect(report.cost.coverage).toBe(12);
  expect(report.configuration_change?.classification).toBe("HARNESS_ONLY");
  expect(renderReport(report)).toContain("Configuration change: HARNESS_ONLY");
  expect(boundary.execute).toHaveBeenCalledTimes(24);
  expect(new Set(boundary.execute.mock.calls.map((call) => call[0])).size).toBe(
    24,
  );
  for (const [, files, input] of boundary.execute.mock.calls) {
    expect(
      (files as FileEntry[]).some(
        (f) => f.path.includes(".fullbeam") || f.path.includes("verifier"),
      ),
    ).toBe(false);
    if (input.role === "generation")
      expect(input.verifierModuleBase64).toBeUndefined();
    else expect(input.verifierModuleBase64).toBeDefined();
  }
  const saved = JSON.parse(
    await readFile(
      join(
        config.stateDir,
        "evidence",
        "comparisons",
        report.comparison.id,
        "report.json",
      ),
      "utf8",
    ),
  );
  expect(saved.report_hash).toBe(report.report_hash);
  expect(saved.comparison.candidate_head_sha).toBe(headSha);
});
it("exposes the same submission policy to both releases and records the exact prompt without changing the historical issue", async () => {
  const issue =
    "Preserve this issue verbatim.\r\n\n  Significant spacing and `code`.\n";
  expect(generationPrompt(issue)).toBe(
    `${GENERATION_SUBMISSION_POLICY}\n\nOriginal issue (verbatim):\n${issue}`,
  );
  expect(GENERATION_SUBMISSION_POLICY).toMatch(/tests\/public\/.*protected/);
  expect(GENERATION_SUBMISSION_POLICY).toContain("tests/agent/");
  const report = await compare(
    config,
    9,
    controllerSha,
    "submission-policy-test",
    null,
    headSha,
  );
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  for (const [id, , input] of boundary.execute.mock.calls.filter(
    ([, , input]) => input.role === "generation",
  )) {
    const envelope = report.runs.find(
      ({ slot }) => `${slot.id}-generation` === id,
    )!;
    const pkg = boundary.objects.get(
      `.fullbeam/private/tasks/${envelope.slot.task_id}.json`,
    ) as TaskPackage;
    expect(pkg.prompt).toBe(
      `${pkg.issue_snapshot.title}\n\n${pkg.issue_snapshot.body}`,
    );
    expect(input.prompt).toBe(generationPrompt(pkg.prompt));
    expect(input.allowedWritePaths).toEqual([
      ...DEFAULT_POLICY.allow_source_prefixes,
    ]);
    const recorded = await store.state<any>(
      `comparisons/${report.comparison.id}/inputs/${envelope.slot.order}.json`,
    );
    expect(recorded).toEqual({
      schema_version: 1,
      slot_id: envelope.slot.id,
      task_digest: pkg.task.digest,
      task_prompt_sha256: sha256(pkg.prompt),
      policy_sha256: sha256(GENERATION_SUBMISSION_POLICY),
      prompt: input.prompt,
      prompt_sha256: sha256(input.prompt),
    });
    const generated = await store.readJson<any>(envelope.run.artifacts[0]!);
    expect(generated.controllerInput).toEqual({
      path: `comparisons/${report.comparison.id}/inputs/${envelope.slot.order}.json`,
      sha256: digest(recorded),
    });
  }
});
it("runs at most two isolated pipelines and checkpoints only after both peers finish", async () => {
  const releaseFirst = deferred();
  let active = 0,
    peak = 0;
  const activeControllers = new Set<number>();
  const generationOrder: string[] = [],
    completed: string[] = [];
  boundary.execute.mockImplementation(
    async (
      id: string,
      files: FileEntry[],
      input: AttemptInput,
      controller: number,
    ) => {
      expect(activeControllers.has(controller)).toBe(false);
      activeControllers.add(controller);
      active++;
      peak = Math.max(peak, active);
      try {
        if (input.role === "generation") {
          generationOrder.push(id);
          if (generationOrder.length === 1) await releaseFirst.promise;
        }
        if (input.role === "verification") {
          completed.push(id);
          if (
            id === generationOrder[1]?.replace(/-generation$/, "-verification")
          )
            releaseFirst.resolve();
        }
        return {
          environment: { id, providerId: id },
          cleanup: "CONFIRMED",
          result: { ...result(files, input.role), executionId: id },
        };
      } finally {
        active--;
        activeControllers.delete(controller);
      }
    },
  );
  boundary.upload.mockImplementation(async (_store: unknown, name: string) => {
    if (name.startsWith("fullbeam-attempt-")) expect(active).toBe(0);
  });
  const report = await compare(
    config,
    9,
    controllerSha,
    "parallel-test",
    null,
    headSha,
  );
  expect(peak).toBe(2);
  expect(boundary.controllerCount).toBe(3);
  expect(report.runs.map(({ slot }) => slot.order)).toEqual(
    Array.from({ length: 12 }, (_, index) => index),
  );
  expect(report.runs.every(({ run }) => run.outcome === "PASS")).toBe(true);
  expect(completed[0]).toBe(
    generationOrder[1]!.replace(/-generation$/, "-verification"),
  );
  expect(
    boundary.upload.mock.calls.filter(([, name]) =>
      name.startsWith("fullbeam-attempt-"),
    ),
  ).toHaveLength(12);
  expect(report.limitations.join("\n")).toContain("up to 2 pipelines");
});
it("halts both pipelines after one generation cleanup fails without allocating verification or omitting slots", async () => {
  const bothStarted = deferred();
  let started = 0;
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => {
      const failedCleanup = ++started === 1;
      if (started === 2) bothStarted.resolve();
      await bothStarted.promise;
      return {
        environment: { id, providerId: id },
        cleanup: failedCleanup ? "FAILED" : "CONFIRMED",
        result: { ...result(files, input.role), executionId: id },
      };
    },
  );
  const report = await compare(
    config,
    9,
    controllerSha,
    "cleanup-failure-test",
    null,
    headSha,
  );
  expect(boundary.execute).toHaveBeenCalledTimes(2);
  expect(
    boundary.execute.mock.calls.every(
      ([, , input]) => input.role === "generation",
    ),
  ).toBe(true);
  expect(report.runs).toHaveLength(12);
  expect(
    report.runs
      .slice(0, 2)
      .filter(
        ({ run }) =>
          run.outcome === "INFRA_ERROR" &&
          /Generation cleanup unconfirmed/.test(run.reason),
      ),
  ).toHaveLength(1);
  expect(
    report.runs
      .slice(0, 2)
      .filter(
        ({ run }) =>
          run.outcome === "CANCELLED" &&
          /Peer resource cleanup unconfirmed/.test(run.reason),
      ),
  ).toHaveLength(1);
  expect(
    report.runs
      .slice(2)
      .every(
        ({ run }) =>
          run.outcome === "CANCELLED" &&
          /Unconfirmed resource cleanup/.test(run.reason),
      ),
  ).toBe(true);
  expect(report.cleanup_status).toBe("FAILED");
});
it.each([false, true])(
  "retains later slots as cancelled when attempt cleanup cannot confirm deletion (throw: %s)",
  async (throws) => {
    boundary.cleanup.mockImplementation(async (controller: number) => {
      if (throws && controller !== 0)
        throw new Error("Cleanup checkpoint unavailable");
      return false;
    });
    const report = await compare(
      config,
      9,
      controllerSha,
      "worker-cleanup-failure-test",
      null,
      headSha,
    );
    expect(report.runs).toHaveLength(12);
    expect(
      report.runs
        .slice(2)
        .every(
          ({ run }) =>
            run.outcome === "CANCELLED" &&
            /Unconfirmed resource cleanup/.test(run.reason),
        ),
    ).toBe(true);
    const generationCalls = boundary.execute.mock.calls.filter(
      ([, , input]) => input.role === "generation",
    );
    // A peer still persisting its input must also stop if cleanup fails first.
    expect(generationCalls.length).toBeGreaterThanOrEqual(1);
    expect(generationCalls.length).toBeLessThanOrEqual(2);
    expect(report.cleanup_status).toBe("FAILED");
  },
);
it("keeps cost-ceiling comparisons sequential and records unstarted slots as cancelled", async () => {
  config.maxCost = 0.00011;
  const report = await compare(
    config,
    9,
    controllerSha,
    "cost-ceiling-test",
    null,
    headSha,
  );
  expect(boundary.controllerCount).toBe(2);
  expect(boundary.execute).toHaveBeenCalledTimes(2);
  expect(report.runs.filter(({ run }) => run.outcome === "PASS")).toHaveLength(
    1,
  );
  expect(
    report.runs.filter(({ run }) => run.outcome === "CANCELLED"),
  ).toHaveLength(11);
  expect(report.limitations.join("\n")).toContain(
    "one pipeline because a measured cost ceiling is configured",
  );
});
it("stops before the next pair if a completed pair's evidence checkpoint fails", async () => {
  boundary.upload.mockImplementation(async (_store: unknown, name: string) => {
    if (name.startsWith("fullbeam-attempt-"))
      throw new Error("Simulated artifact upload failure");
  });
  await expect(
    compare(config, 9, controllerSha, "checkpoint-failure-test", null, headSha),
  ).rejects.toThrow("Simulated artifact upload failure");
  expect(boundary.execute).toHaveBeenCalledTimes(4);
  expect(
    boundary.execute.mock.calls.filter(
      ([, , input]) => input.role === "generation",
    ),
  ).toHaveLength(2);
  expect(
    boundary.execute.mock.calls.filter(
      ([, , input]) => input.role === "verification",
    ),
  ).toHaveLength(2);
});
it("cancels the remaining schedule without provisioning after two active generation attempts stop", async () => {
  const bothStarted = deferred(),
    release = deferred();
  let started = 0;
  const previousExitCode = process.exitCode;
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => {
      if (++started === 2) bothStarted.resolve();
      await release.promise;
      return {
        environment: { id, providerId: id },
        cleanup: "CONFIRMED",
        result: { ...result(files, input.role), executionId: id },
      };
    },
  );
  const comparison = compare(
    config,
    9,
    controllerSha,
    "cancellation-test",
    null,
    headSha,
  );
  try {
    await bothStarted.promise;
    process.exitCode = 130;
    release.resolve();
    const report = await comparison;
    expect(boundary.execute).toHaveBeenCalledTimes(2);
    expect(report.runs).toHaveLength(12);
    expect(report.runs.every(({ run }) => run.outcome === "CANCELLED")).toBe(
      true,
    );
    expect(report.cleanup_status).toBe("CONFIRMED");
  } finally {
    process.exitCode = previousExitCode;
  }
});
it.each([false, true])(
  "executes frozen model settings with bundled harness change %s and leaves the unpriced candidate cost unknown",
  async (bundled) => {
    for (const [sha, model, effort] of [
      [baseSha, "test-model", "low"],
      [headSha, "candidate-model", "high"],
    ] as const) {
      boundary.harnessFiles.set(sha, [
        makeFile(
          "AGENTS.md",
          bundled && sha === headSha
            ? "Candidate repository instructions"
            : "Shared repository instructions",
        ),
        makeFile(
          ".codex/config.toml",
          `model = "${model}"\nmodel_reasoning_effort = "${effort}"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n`,
        ),
        makeFile("skills.md", "Human index for the verify skill"),
        makeFile(
          ".agents/skills/verify/SKILL.md",
          "---\nname: verify\ndescription: Verify the public behavior.\n---\nRun the public checks.\n",
        ),
      ]);
    }
    const report = await compare(
      config,
      9,
      controllerSha,
      "frozen-model-test",
      null,
      headSha,
    );
    expect(report.runs).toHaveLength(12);
    expect(report.summary.execution_completeness).toBe("COMPLETE");
    expect(report.configuration_change).toEqual({
      classification: bundled ? "BUNDLE" : "MODEL_ONLY",
      current: { model: "test-model", reasoning_effort: "low" },
      candidate: { model: "candidate-model", reasoning_effort: "high" },
    });
    const rendered = renderReport(report);
    expect(rendered).toContain(
      `Configuration change: ${bundled ? "BUNDLE" : "MODEL_ONLY"}`,
    );
    expect(rendered).toContain(
      "Current model: test-model; reasoning effort: low",
    );
    expect(rendered).toContain(
      "Candidate model: candidate-model; reasoning effort: high",
    );
    if (bundled)
      expect(rendered).toContain(
        "cannot attribute a difference to either component alone",
      );
    const generations = boundary.execute.mock.calls.filter(
      ([, , input]) => input.role === "generation",
    );
    expect(generations).toHaveLength(12);
    for (const [id, files, input] of generations) {
      const { slot } = report.runs.find(
        ({ slot }) => `${slot.id}-generation` === id,
      )!;
      const candidate = slot.release_id === "candidate";
      const expectedModel = candidate ? "candidate-model" : "test-model";
      const expectedEffort = candidate ? "high" : "low";
      expect(input.model).toBe(expectedModel);
      expect(input.reasoningEffort).toBe(expectedEffort);
      const frozen = (files as FileEntry[]).find(
        (file) => file.path === ".codex/config.toml",
      )!;
      expect(
        parseToml(Buffer.from(frozen.content, "base64").toString()),
      ).toMatchObject({
        model: expectedModel,
        model_reasoning_effort: expectedEffort,
      });
      expect(input.protectedPaths).toEqual(
        expect.arrayContaining([
          ".codex/config.toml",
          "skills.md",
          ".agents/skills/verify/SKILL.md",
        ]),
      );
    }
    for (const { slot, run } of report.runs) {
      if (slot.release_id === "candidate") {
        expect(run.estimated_model_cost).toBeNull();
        expect(run.rate_record_artifact_id).toBeNull();
      } else {
        expect(run.estimated_model_cost).toBeCloseTo(0.00011);
        expect(run.rate_record_artifact_id).toEqual(expect.any(String));
      }
    }
    expect(report.cost.coverage).toBe(6);
    expect(report.cost.measured_usd).toBeCloseTo(0.00066);
    expect(report.cost.cost_per_success).toBeNull();
    expect(renderReport(report)).toContain(
      "spend subtotal USD: 0.000660; coverage: 6/12",
    );
    expect(renderReport(report)).toContain("Cost per success USD: UNKNOWN");
    const store = new EvidenceStore(join(config.stateDir, "evidence"));
    const releases = await Promise.all(
      report.artifacts.map((ref) => store.readJson<any>(ref)),
    );
    expect(releases.map(({ release }) => release.requested_model)).toEqual([
      "test-model",
      "candidate-model",
    ]);
    expect(
      releases.every(({ release }) => release.reported_model === null),
    ).toBe(true);
  },
);
it("prices each known frozen model with its own immutable rate and keeps the operator override model-scoped", async () => {
  config.rates = { input: 2, cached: 0.5, output: 3 };
  for (const [sha, model] of [
    [baseSha, "test-model"],
    [headSha, "gpt-5.6-luna"],
  ] as const)
    boundary.harnessFiles.set(sha, [
      makeFile("AGENTS.md", "Shared instructions"),
      makeFile(
        ".codex/config.toml",
        `model="${model}"\nmodel_reasoning_effort="medium"\napproval_policy="never"\nsandbox_mode="workspace-write"\nweb_search="disabled"\n`,
      ),
    ]);
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => ({
      environment: { id, providerId: id },
      cleanup: "CONFIRMED",
      result: {
        ...result(files, input.role),
        executionId: id,
        events: JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 10,
          },
        }),
      },
    }),
  );
  const report = await compare(
    config,
    9,
    controllerSha,
    "model-rates-test",
    null,
    headSha,
  );
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  const rateIds = new Set<string>();
  for (const { slot, run } of report.runs) {
    expect(run.rate_record_artifact_id).toEqual(expect.any(String));
    const id = run.rate_record_artifact_id!;
    rateIds.add(id);
    const rate = await store.readJson<any>({
      id,
      sha256: id,
      media_type: "application/json",
    });
    expect(run.estimated_model_cost).toBeCloseTo(
      slot.release_id === "current" ? 0.000155 : 0.000023,
    );
    expect(rate).toMatchObject(
      slot.release_id === "current"
        ? {
            model: "test-model",
            source: "operator-configured .env",
            input: 2,
            cached: 0.5,
            output: 3,
          }
        : { model: "gpt-5.6-luna", input: 0.2, cached: 0.02, output: 1.2 },
    );
    expect(rate.limitations.join("\n")).toContain(
      "per-request long-context pricing",
    );
  }
  expect(rateIds.size).toBe(2);
  expect(report.cost.coverage).toBe(12);
  expect(report.cost.measured_usd).toBeCloseTo(0.001068);
  expect(report.limitations.join("\n")).toContain(
    "per-request long-context pricing",
  );
});
it("compares all automated SILVER seed fixtures independently and reports no human GOLD qualification", async () => {
  const benchmark = boundary.objects.get(
    ".fullbeam/benchmark.lock.json",
  ) as BenchmarkLock;
  const originalEntries = [...benchmark.tasks];
  benchmark.tasks = [];
  benchmark.dataset_card.qualification_mode = "AUTOMATED_DEMO";
  benchmark.dataset_card.selection = seedTasks.map((seed) => seed.id);
  for (const [index, seeded] of seedTasks.entries()) {
    const pkg = structuredClone(
      boundary.objects.get(originalEntries[index]!.path),
    ) as TaskPackage;
    const checkIds = expectedCheckIds(seeded.id);
    pkg.subject.task_id = seeded.id;
    pkg.subject.expected_ids = checkIds;
    pkg.controls = (["base", "reference", "mutant"] as const).flatMap((kind) =>
      ([1, 2] as const).map((repeat) => ({
        kind,
        repeat,
        subject_digest: digest(pkg.subject),
        buildPassed: true,
        startupPassed: true,
        checks: checkIds.map((id, checkIndex) => ({
          id,
          status:
            kind !== "reference" && checkIndex === 0
              ? ("FAIL" as const)
              : ("PASS" as const),
        })),
      })),
    );
    const calibration = pkg.controls.map((control) =>
      artifact({
        ...result(pkg.source, "verification"),
        checks: control.checks,
        kind: control.kind,
        repeat: control.repeat,
      }),
    );
    const { digest: _oldDigest, ...originalTask } = pkg.task;
    pkg.task = freezeRecord<Task>({
      ...originalTask,
      id: seeded.id,
      risk: seeded.risk,
      component: seeded.component,
      quality_tier: "SILVER",
      qualified_by: null,
      pass_to_pass_test_ids: checkIds.slice(1),
      fail_to_pass_test_ids: [checkIds[0]!],
      calibration_artifacts: calibration,
    });
    pkg.approval = {
      mode: "AUTOMATED_DEMO",
      actor: "test-operator",
      at: "2026-01-01T00:00:00Z",
      task_digest: pkg.task.digest,
      subject_digest: digest(pkg.subject),
      control_digests: calibration.map((entry) => entry.sha256),
    };
    const path = `.fullbeam/private/tasks/${seeded.id}.json`;
    boundary.objects.set(path, pkg);
    benchmark.tasks.push({ id: seeded.id, digest: pkg.task.digest, path });
  }
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => ({
      environment: { id, providerId: id },
      cleanup: "CONFIRMED",
      result: {
        ...result(files, input.role),
        checks:
          input.role === "verification"
            ? expectedCheckIds(input.taskId!).map((checkId) => ({
                id: checkId,
                status: "PASS",
              }))
            : [],
      },
    }),
  );

  const report = await compare(
    config,
    9,
    controllerSha,
    "automated-demo-test",
    null,
    headSha,
  );
  expect(report.runs).toHaveLength(12);
  expect(report.summary.execution_completeness).toBe("COMPLETE");
  expect(report.runs.every(({ run }) => run.outcome === "PASS")).toBe(true);
  expect(new Set(report.runs.map(({ slot }) => slot.task_id))).toEqual(
    new Set([
      "tenant-event-read",
      "tenant-idempotency",
      "stable-event-pagination",
    ]),
  );
  expect(
    report.runs.every(
      ({ run }) =>
        run.environment_ids.length === 2 &&
        run.environment_ids[0] !== run.environment_ids[1],
    ),
  ).toBe(true);
  const executions = boundary.execute.mock.calls;
  expect(
    executions.filter(([, , input]) => input.role === "generation"),
  ).toHaveLength(12);
  expect(
    executions.filter(([, , input]) => input.role === "verification"),
  ).toHaveLength(12);
  expect(new Set(executions.map(([id]) => id)).size).toBe(24);
  expect(report.limitations.join("\n")).toMatch(
    /AUTOMATED_DEMO.*SILVER.*no human review or GOLD claim/,
  );
  expect(report.comparison.release_decision).toBe(
    "NOT_QUALIFIED_FOR_PRODUCTION",
  );
});
it("retains a failed allocation as one invalid observation while finishing all other slots", async () => {
  boundary.execute.mockRejectedValueOnce(
    new Error("Simulated provider outage"),
  );
  const report = await compare(
    config,
    9,
    controllerSha,
    "test-trigger",
    null,
    headSha,
  );
  expect(report.runs).toHaveLength(12);
  expect(
    report.runs.filter((r) => r.run.outcome === "INFRA_ERROR"),
  ).toHaveLength(1);
  expect(report.summary.invalid_or_missing_attempts).toBe(1);
  expect(report.summary.execution_completeness).toBe("INCOMPLETE");
  expect(boundary.execute).toHaveBeenCalledTimes(23);
});
it("rejects a PR targeting a non-default branch before creating benchmark resources", async () => {
  boundary.baseBranch = "unreviewed-baseline";
  await expect(
    compare(config, 9, controllerSha, "wrong-base-test", null, headSha),
  ).rejects.toThrow(/default branch/);
  expect(boundary.execute).not.toHaveBeenCalled();
  expect(boundary.upload).not.toHaveBeenCalled();
});
it("rejects a mixed application PR before provisioning and rejects a moved head", async () => {
  boundary.mixed = true;
  await expect(
    compare(config, 9, controllerSha, "test-trigger", null, headSha),
  ).rejects.toThrow("mixed");
  boundary.mixed = false;
  await expect(
    compare(config, 9, controllerSha, "test-trigger", null, baseSha),
  ).rejects.toThrow("head changed");
  expect(boundary.execute).not.toHaveBeenCalled();
});
it("rejects verifier policy violations despite every observed assertion passing", async () => {
  boundary.execute.mockImplementation(
    async (id: string, files: FileEntry[], input: AttemptInput) => ({
      environment: { id, providerId: id },
      cleanup: "CONFIRMED",
      result: {
        ...result(files, input.role),
        ...(input.role === "verification"
          ? { status: "POLICY_VIOLATION", violations: ["package-lock.json"] }
          : {}),
      },
    }),
  );
  const report = await compare(
    config,
    9,
    controllerSha,
    "test-trigger",
    null,
    headSha,
  );
  expect(report.runs.every((r) => r.run.outcome === "POLICY_VIOLATION")).toBe(
    true,
  );
  expect(report.summary.execution_completeness).toBe("COMPLETE");
});
it("records six deterministic candidate configuration losses without executing the malformed release", async () => {
  boundary.malformedCandidate = true;
  const report = await compare(
    config,
    9,
    controllerSha,
    "test-trigger",
    null,
    headSha,
  );
  expect(report.runs).toHaveLength(12);
  expect(report.summary.execution_completeness).toBe("COMPLETE");
  expect(
    report.runs
      .filter((r) => r.slot.release_id === "candidate")
      .every((r) => r.run.outcome === "CANDIDATE_CONFIG_ERROR"),
  ).toBe(true);
  expect(
    report.runs
      .filter((r) => r.slot.release_id === "current")
      .every((r) => r.run.outcome === "PASS"),
  ).toBe(true);
  expect(boundary.execute).toHaveBeenCalledTimes(12);
  expect(report.configuration_change?.classification).toBe("UNKNOWN");
  expect(renderReport(report)).toContain("Configuration change: UNKNOWN");
});
