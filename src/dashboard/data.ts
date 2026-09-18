import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { type Config, redact, secretsOf } from "../core/config.js";
import {
  digest,
  normalizePath,
  sha256,
  overlayFiles,
  validateBundle,
  manifestDigest,
  type FileEntry,
} from "../core/integrity.js";
import { EvidenceStore } from "../core/store.js";
import { GitHubActions, type GitHubClient } from "../github/index.js";
import {
  github,
  defaultHead,
  readRepoJson,
} from "../product/github-context.js";
import {
  readArtifactJson,
  selectDispatchedRun,
  type ObservedWorkflowRun,
} from "../product/actions.js";
import {
  createHarnessProposal,
  readHarnessSnapshot,
} from "../product/harness.js";
import { validateReportIdentity } from "../product/report.js";
import type {
  PublishedReport,
  RunEnvelope,
  BenchmarkLock,
  TaskPackage,
} from "../product/types.js";
import { validateRecord, type Comparison } from "../core/records.js";
import { VERIFIED_MODEL_RATES } from "../comparison/pricing.js";
import {
  PostgresDashboardPersistence,
  DashboardLockError,
  type DashboardStore,
} from "./persistence.js";
import {
  createAttemptReviewPr,
  type AttemptReviewPrInput,
} from "../product/attempt-review.js";

export const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"];
export interface StartInput {
  name?: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
  skills?: { path: string; content: string }[];
  pr?: number;
  previous?: string;
}
export function validateStartInput(value: unknown): StartInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  const input = value as StartInput;
  const keys = new Set([
    "name",
    "model",
    "reasoningEffort",
    "instructions",
    "skills",
    "pr",
    "previous",
  ]);
  if (Object.keys(input).some((key) => !keys.has(key)))
    throw new Error("Unsupported run option");
  if (
    input.pr !== undefined &&
    (!Number.isSafeInteger(input.pr) || input.pr < 1)
  )
    throw new Error("Invalid candidate PR");
  if (
    input.pr !== undefined &&
    [input.model, input.reasoningEffort, input.instructions, input.skills].some(
      (v) => v !== undefined,
    )
  )
    throw new Error("An existing PR cannot be combined with new harness edits");
  if (
    input.name !== undefined &&
    (typeof input.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name))
  )
    throw new Error("Name must be a lowercase slug, at most 63 characters");
  if (!input.pr && !input.name) throw new Error("A harness name is required");
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,200}$/.test(input.model))
  )
    throw new Error("Invalid model identifier");
  if (
    input.reasoningEffort !== undefined &&
    !reasoningEfforts.includes(input.reasoningEffort)
  )
    throw new Error("Unsupported reasoning effort");
  if (
    input.previous !== undefined &&
    (typeof input.previous !== "string" ||
      !/^[a-zA-Z0-9._-]{1,150}$/.test(input.previous))
  )
    throw new Error("Invalid previous comparison identity");
  if (
    input.instructions !== undefined &&
    (typeof input.instructions !== "string" ||
      Buffer.byteLength(input.instructions) > 128 * 1024)
  )
    throw new Error("Instructions exceed the text limit");
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > 40)
      throw new Error("Too many skill files");
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of input.skills) {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.content !== "string"
      )
        throw new Error("Invalid skill file");
      normalizePath(file.path);
      if (
        file.path !== "skills.md" &&
        !/^\.agents\/skills\/[a-zA-Z0-9_-]+\/.+/.test(file.path)
      )
        throw new Error("Only native skill paths are editable");
      if (paths.has(file.path)) throw new Error("Duplicate skill path");
      paths.add(file.path);
      bytes += Buffer.byteLength(file.content);
    }
    if (bytes > 512 * 1024) throw new Error("Skill text exceeds the limit");
  }
  if (
    !input.pr &&
    !input.model &&
    !input.reasoningEffort &&
    input.instructions === undefined &&
    !input.skills?.length
  )
    throw new Error("Provide a model or harness change");
  return input;
}

type Json = Record<string, any>;
function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function projectAttempts(
  report: Pick<PublishedReport, "runs" | "configuration_change">,
  objects: Map<string, Json>,
) {
  return report.runs.map(({ slot, run }) => {
    const model = report.configuration_change?.[slot.release_id]?.model ?? null;
    const rawUsage: unknown[] = [];
    const reasoning: number[] = [];
    let reasoningUnknown = false;
    for (const artifact of run.artifacts) {
      const object = objects.get(artifact.id);
      if (typeof object?.events !== "string") continue;
      for (const line of object.events.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type !== "turn.completed" || !event.usage) continue;
          rawUsage.push(event.usage);
          const n = tokens(
            event.usage.output_tokens_details?.reasoning_tokens ??
              event.usage.reasoning_output_tokens ??
              event.usage.reasoning_tokens,
          );
          if (n === null) reasoningUnknown = true;
          else reasoning.push(n);
        } catch {
          /* Non-JSON model log lines are not usage evidence. */
        }
      }
    }
    const usage = run.usage
      ? {
          inputTokens: tokens(run.usage.input_tokens),
          cachedInputTokens: tokens(run.usage.cached_input_tokens),
          outputTokens: tokens(run.usage.output_tokens),
          reasoningTokens:
            !reasoningUnknown && reasoning.length
              ? reasoning.reduce((a, b) => a + b, 0)
              : null,
          complete: run.usage.complete,
        }
      : null;
    const recorded = run.rate_record_artifact_id
      ? objects.get(run.rate_record_artifact_id)
      : undefined;
    const recordedRate =
      recorded?.model === model &&
      [recorded.input, recorded.cached, recorded.output].every(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
      )
        ? recorded
        : undefined;
    const rate =
      recordedRate ?? (model ? VERIFIED_MODEL_RATES[model] : undefined);
    const validRate = !!rate;
    let cost: {
      uncachedInputUsd: number;
      cachedInputUsd: number;
      outputUsd: number;
      totalUsd: number;
    } | null = null;
    if (
      validRate &&
      usage?.complete &&
      usage.inputTokens !== null &&
      usage.cachedInputTokens !== null &&
      usage.outputTokens !== null &&
      usage.cachedInputTokens <= usage.inputTokens
    ) {
      const uncachedInputUsd =
        ((usage.inputTokens - usage.cachedInputTokens) * rate!.input) / 1e6;
      const cachedInputUsd = (usage.cachedInputTokens * rate!.cached) / 1e6;
      const outputUsd = (usage.outputTokens * rate!.output) / 1e6;
      cost = {
        uncachedInputUsd,
        cachedInputUsd,
        outputUsd,
        totalUsd: uncachedInputUsd + cachedInputUsd + outputUsd,
      };
    }
    return {
      id: run.id,
      taskId: slot.task_id,
      release: slot.release_id,
      repeat: run.repeat,
      outcome: run.outcome,
      reason: run.reason,
      checks: run.checks,
      model,
      usage,
      rawUsage,
      cost,
      rate: rate ?? null,
      pricingSource: cost
        ? recordedRate
          ? "Recorded rate artifact (estimate)"
          : "Current verified catalog estimate; not a historical invoice"
        : null,
      recordedCostUsd: run.estimated_model_cost ?? null,
      agentDurationMs: run.agent_duration_ms ?? null,
      totalDurationMs: run.total_duration_ms,
      cleanup: run.cleanup_status,
    };
  });
}

/** A textual view of captured bytes; never invents an agent-authored PR. */
export function capturedChanges(before: FileEntry[], generation: Json) {
  if (
    !generation.integrityVerified ||
    !Array.isArray(generation.files) ||
    !Array.isArray(generation.beforeManifest)
  )
    throw new Error("Generation capture integrity is not verified");
  validateBundle(before);
  validateBundle(generation.files);
  const ordered = (rows: Json[]) =>
    [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    digest(ordered(before.map(({ content: _, ...file }) => file))) !==
    digest(ordered(generation.beforeManifest))
  )
    throw new Error("Captured changes do not match frozen generation input");
  const old = new Map(before.map((file) => [file.path, file]));
  const next = new Map<string, FileEntry>(
    generation.files.map((file: FileEntry) => [file.path, file]),
  );
  const files = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const a = old.get(path),
      b = next.get(path);
    if (a?.sha256 === b?.sha256 && a?.mode === b?.mode) continue;
    const left = a ? Buffer.from(a.content, "base64") : null,
      right = b ? Buffer.from(b.content, "base64") : null;
    const binary = [left, right].some(
      (value) =>
        value &&
        (value.includes(0) ||
          !Buffer.from(value.toString("utf8")).equals(value)),
    );
    const beforeText = binary ? null : (left?.toString("utf8") ?? null);
    const afterText = binary ? null : (right?.toString("utf8") ?? null);
    const leftLines =
        beforeText === null ? [] : beforeText.replace(/\n$/, "").split("\n"),
      rightLines =
        afterText === null ? [] : afterText.replace(/\n$/, "").split("\n");
    files.push({
      path,
      status: !a ? "added" : !b ? "deleted" : "modified",
      before: beforeText,
      after: afterText,
      binary,
      beforeMode: a?.mode ?? null,
      afterMode: b?.mode ?? null,
      diff: binary
        ? null
        : [
            `--- ${a ? `a/${path}` : "/dev/null"}`,
            `+++ ${b ? `b/${path}` : "/dev/null"}`,
            `@@ -${leftLines.length ? 1 : 0},${leftLines.length} +${rightLines.length ? 1 : 0},${rightLines.length} @@`,
            ...leftLines.map((line) => `-${line}`),
            ...rightLines.map((line) => `+${line}`),
          ].join("\n") + "\n",
    });
  }
  return {
    captured: true,
    files,
    violations: generation.violations ?? [],
    truncated: false,
  };
}

function artifactObjects(zip: Uint8Array): Map<string, Json> {
  if (zip.length > 32 * 1024 * 1024)
    throw new Error("Evidence archive is too large");
  let size = 0;
  const files = unzipSync(zip, {
    filter: (file) => {
      normalizePath(file.name.replace(/\/$/, ""));
      size += file.originalSize;
      if (size > 64 * 1024 * 1024 || file.originalSize > 32 * 1024 * 1024)
        throw new Error("Evidence archive is too large");
      return /(?:^|\/)objects\/[a-f0-9]{64}$/.test(file.name);
    },
  });
  const result = new Map<string, Json>();
  for (const [path, bytes] of Object.entries(files)) {
    const id = path.split("/").at(-1)!;
    if (sha256(bytes) !== id)
      throw new Error("Evidence object digest mismatch");
    try {
      result.set(id, JSON.parse(Buffer.from(bytes).toString()));
    } catch {
      /* Binary objects are not accounting data. */
    }
  }
  return result;
}

export function readProgressSnapshot(
  zip: Uint8Array,
  runId: number,
  repositoryId: number,
  objects = artifactObjects(zip),
) {
  const comparison = readArtifactJson<Comparison>(zip, "comparison.json");
  if (
    comparison.github_actions_run_id !== String(runId) ||
    comparison.repository_id !== String(repositoryId)
  )
    throw new Error(
      "Progress snapshot belongs to a different run or repository",
    );
  validateRecord(comparison);
  const schedule = readArtifactJson<{ slots: PublishedReport["slots"] }>(
    zip,
    "schedule.json",
  );
  const prefix = `comparisons/${comparison.id}/runs/`;
  const files = unzipSync(zip, {
    filter: (file) =>
      file.name.startsWith(prefix) &&
      /^\d+\.json$/.test(file.name.slice(prefix.length)),
  });
  const runs: RunEnvelope[] = [];
  for (const bytes of Object.values(files)) {
    const envelope = JSON.parse(Buffer.from(bytes).toString()) as RunEnvelope;
    const expected = schedule.slots.find(
      (slot) => slot.id === envelope.slot.id,
    );
    if (
      !expected ||
      digest(expected) !== digest(envelope.slot) ||
      envelope.run.comparison_id !== comparison.id ||
      envelope.run.id !== expected.id ||
      envelope.run.release_digest !== expected.release_digest ||
      envelope.run.task_digest !== expected.task_digest
    )
      throw new Error("Attempt snapshot disagrees with its frozen schedule");
    validateRecord(envelope.run);
    runs.push(envelope);
  }
  const settings = (role: "current" | "candidate") => {
    const hash =
      comparison[
        role === "current"
          ? "current_release_digest"
          : "candidate_release_digest"
      ];
    const release = [...objects.values()].find(
      (value) => value.release?.digest === hash,
    );
    return {
      model: release?.release?.requested_model ?? "UNKNOWN",
      reasoning_effort: release?.settings?.model_reasoning_effort ?? null,
    };
  };
  return {
    comparison,
    slots: schedule.slots,
    runs: runs.sort((a, b) => a.slot.order - b.slot.order),
    configuration_change: {
      classification: "UNKNOWN" as const,
      current: settings("current"),
      candidate: settings("candidate"),
    },
  };
}

export interface DashboardDataSource {
  overview(): Promise<unknown>;
  listRuns(): Promise<unknown[]>;
  run(id: number): Promise<unknown>;
  harness(): Promise<unknown>;
  start(input: StartInput): Promise<unknown>;
  reviewAttempt?(runId: number, attemptId: string): Promise<unknown>;
  jobs?(): Promise<unknown[]>;
  open?(): Promise<void>;
  close?(): Promise<void>;
}
interface QueueJob {
  jobId: string;
  name: string;
  status:
    | "queued"
    | "preparing"
    | "dispatching"
    | "dispatch_unknown"
    | "running"
    | "completed"
    | "failed";
  input: StartInput;
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
  intent?: {
    trigger: string;
    head: string;
    branch: string;
    dispatchedAt: number;
    pr: number;
  };
  runId?: number;
  url?: string;
  conclusion?: string | null;
  error?: string;
  waitingForRunId?: number;
  archival?: {
    status: "pending" | "archived" | "unavailable";
    attempts: number;
    nextAttemptAt?: number;
    error?: string;
  };
}
export class DashboardData implements DashboardDataSource {
  private client: GitHubClient;
  private actions: GitHubActions;
  private store: DashboardStore;
  private postgres?: PostgresDashboardPersistence;
  private workerError: string | null = null;
  private completed = new Map<number, unknown>();
  private workflowArchiveWrites = new Map<number, Promise<void>>();
  private reviewSnapshotWrites = new Map<string, Promise<void>>();
  private reviewPublishes = new Map<string, Promise<unknown>>();
  private reviewMetadata = new Map<
    string,
    { at: number; value: Promise<Json> }
  >();
  private progressCache = new Map<
    number,
    {
      objects: Map<string, Json>;
      progress: ReturnType<typeof readProgressSnapshot>;
    }
  >();
  private historyError: string | null = null;
  private taskCache = new Map<string, Promise<TaskPackage[]>>();
  private queue: QueueJob[] = [];
  private queueLoaded?: Promise<void>;
  private queueStore: DashboardStore;
  private writes: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private working = false;
  private closing = false;
  private workerLock?: string;
  private pendingSubmissions = new Set<string>();
  private catalog?: {
    at: number;
    models: { id: string }[];
    modelError: string | null;
  };
  constructor(private config: Config) {
    this.client = github(config);
    this.actions = new GitHubActions(this.client);
    if (config.databaseUrl) {
      this.postgres = new PostgresDashboardPersistence(
        config.databaseUrl,
        config.repository,
        config.stateDir,
      );
      this.store = this.postgres.scope("dashboard");
      this.queueStore = this.postgres.scope();
    } else {
      // Unit tests may use isolated files. The real HTTP server requires Postgres.
      this.store = new EvidenceStore(join(config.stateDir, "dashboard"));
      this.queueStore = new EvidenceStore(config.stateDir);
    }
  }
  private async archived(id: number): Promise<Json | null> {
    const saved = await this.store.state<Json>(`completed/${id}.json`);
    if (!saved) return null;
    if (
      saved.schema_version !== 1 ||
      saved.repository !== this.config.repository ||
      saved.run_id !== id ||
      saved.detail?.run?.id !== id ||
      saved.detail?.run?.status !== "completed" ||
      !saved.detail.report ||
      digest(saved.detail) !== saved.detail_digest ||
      saved.detail.report.comparison.repository_id !==
        String(saved.repository_id)
    )
      throw new Error(
        "Archived dashboard evidence integrity or repository identity mismatch",
      );
    validateReportIdentity(saved.detail.report, id, saved.repository_id);
    const extra = await this.store.state<Json>(
      `completed/${id}.enrichment-v2.json`,
    );
    if (
      extra &&
      (extra.repository !== this.config.repository ||
        extra.run_id !== id ||
        extra.report_hash !== saved.detail.report.report_hash ||
        digest(extra.details) !== extra.details_digest)
    )
      throw new Error("Archived dashboard enrichment integrity mismatch");
    return {
      ...saved.detail,
      ...(extra?.details ?? {}),
      archived: true,
      archivedAt: saved.archived_at,
    };
  }
  private async archiveCompleted(id: number, detail: Json) {
    if (
      detail.run?.status !== "completed" ||
      !detail.report ||
      detail.artifactError
    )
      return;
    const repositoryId = Number(detail.report.comparison.repository_id);
    if (
      detail.run.id !== id ||
      !Number.isSafeInteger(repositoryId) ||
      repositoryId < 1
    )
      throw new Error("Invalid completed dashboard identity");
    validateReportIdentity(detail.report, id, repositoryId);
    const assertSameReport = (existing: Json) => {
      if (
        existing.report.report_hash !== detail.report.report_hash ||
        digest(existing.report) !== digest(detail.report)
      )
        throw new Error(
          "Completed report differs from archived immutable evidence",
        );
    };
    let existing = await this.archived(id);
    if (!existing) {
      try {
        await this.store.immutable(`completed/${id}.json`, {
          schema_version: 1,
          repository: this.config.repository,
          repository_id: repositoryId,
          run_id: id,
          archived_at: new Date().toISOString(),
          detail_digest: digest(detail),
          detail,
        });
      } catch (error) {
        // A concurrent reader may already have archived this exact report with
        // a different timestamp or GitHub job/publication metadata wrapper.
        // Preserve that first valid record; never overwrite it or suppress a
        // changed report identity, corrupted record, or unavailable database.
        existing = await this.archived(id);
        if (!existing) throw error;
      }
    }
    if (existing) assertSameReport(existing);
    if (detail.enrichmentVersion === 2) {
      const details = {
        enrichmentVersion: 2,
        tasks: detail.tasks,
        configuration: detail.configuration,
        comparison: detail.comparison,
        configurationChange: detail.configurationChange,
        attempts: detail.attempts,
        harnesses: detail.harnesses,
      };
      const path = `completed/${id}.enrichment-v2.json`;
      if (!(await this.store.state(path))) {
        try {
          await this.store.immutable(path, {
            repository: this.config.repository,
            run_id: id,
            report_hash: detail.report.report_hash,
            details_digest: digest(details),
            details,
          });
        } catch (error) {
          if (!(await this.store.state(path))) throw error;
          // Validate the winning enrichment's digest and original report binding.
          const winner = await this.archived(id);
          if (!winner) throw error;
          assertSameReport(winner);
        }
      }
    }
  }
  private async archivedWorkflow(id: number): Promise<Json | null> {
    const saved = await this.store.state<Json>(`workflows/${id}.json`);
    if (!saved) return null;
    if (
      saved.schema_version !== 1 ||
      saved.repository !== this.config.repository ||
      saved.run_id !== id ||
      saved.run?.id !== id ||
      saved.run?.status !== "completed" ||
      digest(saved.run) !== saved.run_digest
    )
      throw new Error("Archived workflow summary integrity mismatch");
    return { ...saved.run, archived: true, archivedAt: saved.archived_at };
  }
  private async archiveWorkflow(run: Json) {
    if (
      run.status !== "completed" ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1
    )
      return;
    let pending = this.workflowArchiveWrites.get(run.id);
    if (!pending) {
      pending = (async () => {
        if (await this.archivedWorkflow(run.id)) return;
        await this.store.immutable(`workflows/${run.id}.json`, {
          schema_version: 1,
          repository: this.config.repository,
          run_id: run.id,
          run,
          run_digest: digest(run),
          archived_at: new Date().toISOString(),
        });
      })();
      this.workflowArchiveWrites.set(run.id, pending);
      pending.catch(() => this.workflowArchiveWrites.delete(run.id));
    }
    return pending;
  }
  private async archivedFiles(directory: string): Promise<string[]> {
    try {
      return this.postgres
        ? (await this.postgres.list(`dashboard/${directory}/`)).map((key) =>
            key.slice(`dashboard/${directory}/`.length),
          )
        : await readdir(join(this.config.stateDir, "dashboard", directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async archivedHistory() {
    const [files, workflowFiles] = await Promise.all([
      this.archivedFiles("completed"),
      this.archivedFiles("workflows"),
    ]);
    const summaries = new Map<number, Json>();
    for (const file of workflowFiles.filter((file) =>
      /^[1-9][0-9]*\.json$/.test(file),
    )) {
      const run = await this.archivedWorkflow(Number(file.slice(0, -5)));
      if (run) summaries.set(run.id, run);
    }
    for (const file of files.filter((file) =>
      /^[1-9][0-9]*\.json$/.test(file),
    )) {
      const detail = await this.archived(Number(file.slice(0, -5)));
      if (detail)
        summaries.set(detail.run.id, { ...detail.run, archived: true });
    }
    return [...summaries.values()];
  }
  private loadQueue() {
    return (this.queueLoaded ??= (async () => {
      const saved = await this.queueStore.state<{
        schema_version: number;
        repository: string;
        jobs: QueueJob[];
      }>("dashboard-jobs.json");
      if (!saved) return;
      if (
        saved.schema_version !== 1 ||
        saved.repository !== this.config.repository ||
        !Array.isArray(saved.jobs)
      )
        throw new Error("Dashboard queue identity mismatch");
      for (const job of saved.jobs) {
        validateStartInput(job.input);
        if (
          digest(job.input) !== job.inputDigest ||
          !/^[a-f0-9-]{36}$/.test(job.jobId) ||
          ![
            "queued",
            "preparing",
            "dispatching",
            "dispatch_unknown",
            "running",
            "completed",
            "failed",
          ].includes(job.status)
        )
          throw new Error("Dashboard queue integrity mismatch");
        if (
          ["dispatching", "dispatch_unknown", "running"].includes(job.status) &&
          !job.intent
        )
          throw new Error("Dashboard queue has no durable dispatch identity");
      }
      this.queue = saved.jobs;
    })());
  }
  private saveQueue() {
    const snapshot = structuredClone({
      schema_version: 1,
      repository: this.config.repository,
      jobs: this.queue,
    });
    const pending = this.writes.then(() =>
      this.queueStore.saveState("dashboard-jobs.json", snapshot),
    );
    this.writes = pending.catch(() => {});
    return pending;
  }
  async jobs() {
    await this.loadQueue();
    return this.queue.map(({ input, inputDigest: _, intent, ...job }) => ({
      ...job,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      trigger: intent?.trigger ?? null,
      pr: intent?.pr ?? input.pr ?? null,
    }));
  }
  async open() {
    if (this.postgres) await this.postgres.acquireWorker();
    await this.loadQueue();
    if (!this.timer) {
      if (!this.postgres) {
        const path = join(this.config.stateDir, "dashboard-worker.json");
        await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
        const claim = JSON.stringify({ pid: process.pid, id: randomUUID() });
        try {
          await writeFile(path, claim, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const previous = await readFile(path, "utf8");
          const owner = JSON.parse(previous) as { pid: number };
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
            throw new Error("Invalid dashboard worker lock");
          try {
            process.kill(owner.pid, 0);
            throw new Error(
              "Another dashboard worker is already running for this state directory",
            );
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== "ESRCH")
              throw failure;
          }
          if ((await readFile(path, "utf8")) !== previous)
            throw new Error("Dashboard worker lock changed");
          await unlink(path);
          await writeFile(path, claim, { flag: "wx", mode: 0o600 });
        }
        this.workerLock = claim;
      }
      this.closing = false;
      this.timer = setInterval(() => {
        void this.processJobs().catch(() => {});
      }, 3000);
      this.timer.unref();
      void this.processJobs().catch(() => {});
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.working)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await this.writes;
    if (this.postgres) await this.postgres.close();
    if (this.workerLock) {
      const path = join(this.config.stateDir, "dashboard-worker.json");
      if ((await readFile(path, "utf8")) === this.workerLock)
        await unlink(path);
      this.workerLock = undefined;
    }
  }
  /** One serial worker; persisted intent is never dispatched twice after restart. */
  async processJobs() {
    await this.loadQueue();
    if (this.working || this.closing) return;
    const job = this.queue.find(
      (entry) =>
        !["completed", "failed"].includes(entry.status) &&
        !this.pendingSubmissions.has(entry.jobId),
    );
    const archiveDue = this.queue.find(
      (entry) =>
        entry.status === "completed" &&
        entry.conclusion === "success" &&
        entry.runId &&
        !["archived", "unavailable"].includes(entry.archival?.status ?? "") &&
        (entry.archival?.nextAttemptAt ?? 0) <= Date.now(),
    );
    if (!job && !archiveDue) return;
    this.working = true;
    try {
      if (this.postgres) await this.postgres.assertWorker();
      if (archiveDue) {
        await this.archiveJob(archiveDue);
        await this.saveQueue();
      }
      if (!job) return;
      if (job.intent) {
        const response = await this.client.rest<{
          workflow_runs: ObservedWorkflowRun[];
        }>(
          "GET",
          "actions/workflows/fullbeam-compare.yml/runs?event=workflow_dispatch&per_page=100",
        );
        const run = selectDispatchedRun(
          response.workflow_runs,
          "compare",
          job.intent.trigger,
          job.intent.head,
          job.intent.dispatchedAt,
        );
        if (run) {
          job.runId = run.id;
          job.url = run.html_url;
          job.conclusion = run.conclusion;
          job.status = run.status === "completed" ? "completed" : "running";
          delete job.error;
          const names =
            (await this.store.state<Record<string, string>>("names.json")) ??
            {};
          names[String(run.id)] = job.name;
          await this.store.saveState("names.json", names);
          if (run.status === "completed") {
            await this.archiveWorkflow(this.summary(run, names));
            await this.archiveJob(job);
          }
        } else {
          job.status = "dispatch_unknown";
          job.error =
            "Dispatch intent is recorded; awaiting its unique GitHub receipt. It will not be submitted again automatically.";
        }
        job.updatedAt = new Date().toISOString();
        await this.saveQueue();
        return;
      }
      const active = (await this.listRuns()).find(
        (run) => run.status !== "completed",
      );
      if (this.historyError) {
        job.error =
          "Waiting for GitHub to confirm whether another comparison is active";
        await this.saveQueue();
        return;
      }
      if (active) {
        if (job.waitingForRunId !== active.id) {
          job.waitingForRunId = active.id;
          await this.saveQueue();
        }
        return;
      }
      delete job.waitingForRunId;
      job.status = "preparing";
      job.updatedAt = new Date().toISOString();
      await this.saveQueue();
      const prepared = await this.prepare(job.input);
      if (this.closing) return;
      if (this.postgres) await this.postgres.assertWorker();
      job.intent = {
        trigger: randomUUID(),
        head: prepared.head.sha,
        branch: prepared.head.branch,
        dispatchedAt: Date.now(),
        pr: prepared.pr,
      };
      job.status = "dispatching";
      job.updatedAt = new Date().toISOString();
      await this.saveQueue();
      if (this.postgres) await this.postgres.assertWorker();
      await this.actions.dispatchWorkflow({
        workflow: "fullbeam-compare.yml",
        ref: job.intent.branch,
        inputs: {
          operation: "compare",
          trigger_id: job.intent.trigger,
          candidate_pr: String(job.intent.pr),
          previous_id: job.input.previous ?? "",
        },
      });
    } catch (error) {
      if (error instanceof DashboardLockError) {
        this.workerError = this.safe(error);
        this.closing = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      if (!job) throw error;
      job.error = this.safe(error);
      job.status = job.intent ? "dispatch_unknown" : "failed";
      job.updatedAt = new Date().toISOString();
      await this.saveQueue();
    } finally {
      this.working = false;
    }
  }
  private async archiveJob(job: QueueJob) {
    const attempts = (job.archival?.attempts ?? 0) + 1;
    let failure = "GitHub has not exposed a verified completed report yet";
    try {
      const detail = (await this.run(job.runId!)) as Json;
      if (detail.report && (await this.archived(job.runId!))) {
        job.archival = { status: "archived", attempts };
        return;
      }
      failure = detail.artifactError ?? failure;
    } catch (error) {
      if (error instanceof DashboardLockError) throw error;
      failure = this.safe(error);
    }
    job.archival = {
      status:
        attempts >= 20 || job.conclusion !== "success"
          ? "unavailable"
          : "pending",
      attempts,
      nextAttemptAt: Date.now() + Math.min(attempts * 10000, 60000),
      error: failure,
    };
  }
  private safe(error: unknown) {
    return redact(
      error instanceof Error ? error.message : String(error),
      secretsOf(this.config),
    );
  }
  async models() {
    if (this.catalog && Date.now() - this.catalog.at < 5 * 60_000)
      return this.catalog;
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${this.config.openaiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          `OpenAI model catalog returned HTTP ${response.status}`,
        );
      const body = (await response.json()) as { data: { id: string }[] };
      if (!Array.isArray(body.data))
        throw new Error("Invalid model catalog response");
      const models = body.data
        .filter(
          (m) => typeof m.id === "string" && /^(gpt-|o[1-9]|codex-)/.test(m.id),
        )
        .map(({ id }) => ({ id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      this.catalog = { at: Date.now(), models, modelError: null };
    } catch (error) {
      this.catalog = {
        at: Date.now(),
        models: [],
        modelError: this.safe(error),
      };
    }
    return this.catalog;
  }
  async overview() {
    const [catalog, runs] = await Promise.all([this.models(), this.listRuns()]);
    return {
      repository: this.config.repository,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      models: catalog.models,
      modelError: catalog.modelError,
      modelAvailabilityNote:
        "Listed by this OpenAI account; individual model reasoning support is checked by the native execution.",
      modelRates: VERIFIED_MODEL_RATES,
      reasoningEfforts,
      runs,
      historyError: this.historyError,
      persistence: this.postgres
        ? {
            provider: "instacloud-postgres",
            status: this.workerError ? "blocked" : "connected",
            history: "persisted",
            queue: "persisted",
            error: this.workerError,
          }
        : {
            provider: "test-filesystem",
            status: "test-only",
            history: "local",
            queue: "local",
          },
    };
  }
  private summary(
    run: ObservedWorkflowRun & { updated_at?: string },
    names: Record<string, string> = {},
  ) {
    return {
      id: run.id,
      name: names[String(run.id)] ?? run.display_title,
      trigger: run.display_title.replace(/^Fullbeam compare /, ""),
      operation: "compare",
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at ?? run.created_at,
      url: run.html_url,
      headSha: run.head_sha,
    };
  }
  async listRuns() {
    const [archived, names] = await Promise.all([
      this.archivedHistory(),
      this.store.state<Record<string, string>>("names.json"),
    ]);
    let runs: ObservedWorkflowRun[];
    try {
      runs = await this.client.paginateByField<ObservedWorkflowRun>(
        "actions/workflows/fullbeam-compare.yml/runs",
        "workflow_runs",
        { event: "workflow_dispatch", per_page: 100 },
      );
      this.historyError = null;
    } catch (error) {
      this.historyError = this.safe(error);
      if (!archived.length) throw error;
      // Previously verified local evidence remains readable during provider outages.
      return archived;
    }
    const merged = new Map<number, any>(archived.map((run) => [run.id, run]));
    for (const run of runs
      .filter((run) =>
        /^Fullbeam compare [a-zA-Z0-9-]+$/.test(run.display_title),
      )
      .map((run) => this.summary(run, names ?? {}))) {
      await this.archiveWorkflow(run);
      merged.set(run.id, run);
    }
    return [...merged.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }
  async harness() {
    const snapshot = await readHarnessSnapshot(this.config);
    return {
      head: snapshot.head,
      files: snapshot.files.map((file) => ({
        path: file.path,
        content: Buffer.from(file.content, "base64").toString("utf8"),
        mode: file.mode,
      })),
    };
  }
  private async evaluationDetails(
    source: Pick<
      PublishedReport,
      "comparison" | "runs" | "configuration_change"
    >,
    objects: Map<string, Json>,
  ) {
    const comparison = source.comparison;
    const cacheKey = `${comparison.benchmark_source_sha}:${comparison.benchmark_digest}`;
    let pending = this.taskCache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const benchmark = await readRepoJson<BenchmarkLock>(
          this.client,
          ".fullbeam/benchmark.lock.json",
          comparison.benchmark_source_sha,
        );
        if (
          digest(benchmark) !== comparison.benchmark_digest ||
          benchmark.repository_id !== comparison.repository_id
        )
          throw new Error("Frozen benchmark identity mismatch");
        return Promise.all(
          benchmark.tasks.map(async (entry) => {
            const pkg = await readRepoJson<TaskPackage>(
              this.client,
              entry.path,
              comparison.benchmark_source_sha,
            );
            validateRecord(pkg.task);
            if (
              pkg.task.id !== entry.id ||
              pkg.task.digest !== entry.digest ||
              manifestDigest(pkg.source) !== pkg.task.source_bundle_sha256
            )
              throw new Error("Frozen task source identity mismatch");
            return pkg;
          }),
        );
      })();
      this.taskCache.set(cacheKey, pending);
      pending.catch(() => this.taskCache.delete(cacheKey));
    }
    const packages = await pending;
    const baseUrl = `https://github.com/${this.config.repository}`;
    const tasks = packages.map((pkg) => ({
      id: pkg.task.id,
      title: pkg.issue_snapshot.title,
      prompt: pkg.prompt,
      passToPassCheckIds: pkg.task.pass_to_pass_test_ids,
      failToPassCheckIds: pkg.task.fail_to_pass_test_ids,
      allowedWritePaths: pkg.task.allowed_source_prefixes,
      sourceCommit: pkg.task.base_sha,
      referenceCommit: pkg.task.reference_sha,
      issueUrl: `${baseUrl}/issues/${pkg.task.issue_number}`,
      referencePrUrl: `${baseUrl}/pull/${pkg.task.pull_request_number}`,
    }));
    const attempts = await Promise.all(
      projectAttempts(source, objects).map(async (attempt, index) => {
        const envelope = source.runs[index]!;
        const raws = envelope.run.artifacts.map((ref) => objects.get(ref.id));
        const generation = raws.find((value) => value?.role === "generation"),
          verifier = raws.find((value) => value?.role === "verification");
        const release = [...objects.values()].find(
          (value) => value.release?.digest === envelope.run.release_digest,
        );
        const pkg = packages.find(
          (pkg) => pkg.task.id === envelope.slot.task_id,
        );
        let changes: Json = {
          captured: false,
          files: [],
          violations: generation?.violations ?? [],
          truncated: false,
          error: "No verified generation capture is available",
        };
        if (generation && release && pkg) {
          try {
            changes = capturedChanges(
              overlayFiles(pkg.source, release.files),
              generation,
            );
            await this.saveReviewSnapshot({
              comparison,
              envelope,
              taskSource: pkg.source,
              release,
              generation,
              generationDigest: digest(generation),
            } as AttemptReviewPrInput);
          } catch (error) {
            changes.error = this.safe(error);
          }
        }
        return {
          ...attempt,
          changes,
          nativeConfiguration: generation?.effectiveNativeSettings ?? null,
          verifier: verifier
            ? {
                status: verifier.status,
                buildPassed: verifier.buildPassed ?? null,
                startupPassed: verifier.startupPassed ?? null,
                checks: verifier.checks,
                failureKind: verifier.failureKind ?? null,
                integrityVerified: verifier.integrityVerified,
              }
            : null,
        };
      }),
    );
    return {
      enrichmentVersion: 2,
      tasks,
      attempts,
      configuration: {
        candidatePr: {
          number: comparison.candidate_pr,
          url: `${baseUrl}/pull/${comparison.candidate_pr}`,
        },
        candidateCommit: comparison.candidate_head_sha,
        baselineCommit: comparison.baseline_source_sha,
        benchmarkCommit: comparison.benchmark_source_sha,
        controllerCommit: comparison.controller_commit_sha,
      },
    };
  }
  async run(id: number, refreshEvidence = false) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Invalid Actions run ID");
    const memory = this.completed.get(id) as Json | undefined;
    if (!refreshEvidence && memory?.enrichmentVersion === 2)
      return this.withReviewPrs(id, memory);
    const archived = await this.archived(id);
    if (!refreshEvidence && archived?.enrichmentVersion === 2) {
      this.completed.set(id, archived);
      return this.withReviewPrs(id, archived);
    }
    let observed;
    try {
      observed = await this.client.rest<
        ObservedWorkflowRun & {
          repository: { id: number; full_name: string };
          path: string;
          updated_at: string;
        }
      >("GET", `actions/runs/${id}`);
    } catch (error) {
      if (archived)
        return this.withReviewPrs(id, {
          ...archived,
          enrichmentError: `Previously verified report retained; task/change enrichment unavailable: ${this.safe(error)}`,
        });
      const summary = await this.archivedWorkflow(id);
      if (summary)
        return {
          run: summary,
          report: null,
          attempts: [],
          tasks: [],
          harnesses: {},
          progress: null,
          artifactError:
            "Remote evidence is unavailable; only the observed workflow summary was retained",
          archived: true,
          jobs: [],
        };
      throw error;
    }
    if (
      observed.repository.full_name.toLowerCase() !==
        this.config.repository.toLowerCase() ||
      !/^Fullbeam compare /.test(observed.display_title) ||
      observed.path.split("@")[0] !== ".github/workflows/fullbeam-compare.yml"
    )
      throw new Error("Run is outside this dashboard's comparison workflow");
    const names = await this.store.state<Record<string, string>>("names.json");
    await this.archiveWorkflow(this.summary(observed, names ?? {}));
    const [artifacts, jobs] = await Promise.all([
      this.actions.listRunArtifacts(id),
      this.client.paginateByField<Json>(`actions/runs/${id}/jobs`, "jobs", {
        per_page: 100,
      }),
    ]);
    let report: PublishedReport | null = null,
      publication: unknown = null,
      artifactError: string | null = null;
    let objects = new Map<string, Json>();
    let progress: ReturnType<typeof readProgressSnapshot> | null = null;
    const evidence = artifacts.find(
      (a) => a.name === `fullbeam-evidence-${id}` && !a.expired,
    );
    if (evidence) {
      try {
        const archive = await this.actions.downloadRunArtifact(
          id,
          evidence.name,
        );
        objects = artifactObjects(archive.zip);
        try {
          report = readArtifactJson<PublishedReport>(
            archive.zip,
            "report.json",
          );
        } catch (error) {
          if (observed.conclusion !== "cancelled") throw error;
        }
        if (report) validateReportIdentity(report, id, observed.repository.id);
      } catch (error) {
        artifactError = this.safe(error);
        report = null;
      }
    }
    if (!report) {
      const snapshots = artifacts
        .filter(
          (a) =>
            !a.expired &&
            new RegExp(
              `^fullbeam-(?:attempt|plan)-${id}-[1-9][0-9]*-[a-f0-9]{8}(?:-[0-9]+)?$`,
            ).test(a.name),
        )
        .sort(
          (a, b) =>
            Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
        );
      const latest = snapshots[0];
      if (latest)
        try {
          let cached = this.progressCache.get(latest.id);
          if (!cached) {
            const archive = await this.actions.downloadRunArtifact(
              id,
              latest.name,
            );
            const snapshotObjects = artifactObjects(archive.zip);
            cached = {
              objects: snapshotObjects,
              progress: readProgressSnapshot(
                archive.zip,
                id,
                observed.repository.id,
                snapshotObjects,
              ),
            };
            this.progressCache.set(latest.id, cached);
          }
          objects = cached.objects;
          progress = cached.progress;
        } catch (error) {
          artifactError = this.safe(error);
        }
    }
    const published = artifacts.find(
      (a) => a.name === `fullbeam-publication-${id}` && !a.expired,
    );
    if (published) {
      try {
        const archive = await this.actions.downloadRunArtifact(
          id,
          published.name,
        );
        const value = readArtifactJson<Json>(archive.zip, "publication.json");
        if (
          value.repository !== this.config.repository ||
          value.run_id !== String(id)
        )
          throw new Error("Publication identity mismatch");
        publication = value;
      } catch (error) {
        artifactError = this.safe(error);
      }
    }
    const harnesses: Record<string, unknown> = {};
    const sourceReport = report ?? progress;
    if (sourceReport)
      for (const release of ["current", "candidate"] as const) {
        const wanted =
          sourceReport.comparison[
            release === "current"
              ? "current_release_digest"
              : "candidate_release_digest"
          ];
        const found = [...objects.values()].find(
          (obj) => obj.release?.digest === wanted,
        );
        if (found && Array.isArray(found.files))
          harnesses[release] = {
            settings: found.settings,
            sourceCommit: found.release.source_commit,
            nativeVersion: found.release.client_version,
            files: found.files.map((f: Json) => ({
              path: f.path,
              content: Buffer.from(f.content, "base64").toString("utf8"),
            })),
          };
      }
    if (archived && !report)
      return this.withReviewPrs(id, {
        ...archived,
        enrichmentError:
          "Previously verified report retained; original artifacts are unavailable for task/change enrichment",
      });
    let evaluation: Json = { tasks: [], enrichmentError: null };
    if (sourceReport)
      try {
        evaluation = await this.evaluationDetails(sourceReport, objects);
      } catch (error) {
        evaluation.enrichmentError = this.safe(error);
      }
    const result = {
      run: this.summary(observed, names ?? {}),
      report,
      attempts: sourceReport ? projectAttempts(sourceReport, objects) : [],
      ...evaluation,
      comparison: sourceReport?.comparison ?? null,
      configurationChange: sourceReport?.configuration_change ?? null,
      progress: sourceReport
        ? {
            observedAttempts: sourceReport.runs.length,
            plannedAttempts: sourceReport.slots.length,
            comparisonId: sourceReport.comparison.id,
          }
        : null,
      publication,
      artifactError,
      harnesses,
      jobs: jobs.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
      })),
      artifactAvailability: artifacts.map(({ name, expired }) => ({
        name,
        expired,
      })),
    };
    await this.archiveCompleted(id, result);
    if (
      observed.status === "completed" &&
      report &&
      !artifactError &&
      evaluation.enrichmentVersion === 2
    )
      this.completed.set(id, result);
    return this.withReviewPrs(id, result);
  }
  private snapshotPath(runId: number, attemptId: string) {
    return `review-snapshots/${runId}/${sha256(attemptId)}.json`;
  }
  private receiptPath(runId: number, attemptId: string) {
    return `review-prs/${runId}/${sha256(attemptId)}.json`;
  }
  private async saveReviewSnapshot(input: AttemptReviewPrInput) {
    const runId = Number(input.comparison.github_actions_run_id),
      attemptId = input.envelope.run.id;
    const path = this.snapshotPath(runId, attemptId);
    let pending = this.reviewSnapshotWrites.get(path);
    if (!pending) {
      pending = (async () => {
        const existing = await this.store.state<Json>(path);
        if (existing) {
          if (
            existing.input_digest !== digest(input) ||
            digest(existing.input) !== existing.input_digest
          )
            throw new Error("Attempt review snapshot integrity mismatch");
          return;
        }
        await this.store.immutable(path, {
          schema_version: 1,
          repository: this.config.repository,
          run_id: runId,
          attempt_id: attemptId,
          input_digest: digest(input),
          input,
        });
      })();
      this.reviewSnapshotWrites.set(path, pending);
      pending.catch(() => this.reviewSnapshotWrites.delete(path));
    }
    return pending;
  }
  private async reviewSnapshot(runId: number, attemptId: string) {
    const saved = await this.store.state<Json>(
      this.snapshotPath(runId, attemptId),
    );
    if (!saved) return null;
    if (
      saved.schema_version !== 1 ||
      saved.repository !== this.config.repository ||
      saved.run_id !== runId ||
      saved.attempt_id !== attemptId ||
      digest(saved.input) !== saved.input_digest ||
      Number(saved.input?.comparison?.github_actions_run_id) !== runId ||
      saved.input?.envelope?.run?.id !== attemptId ||
      digest(saved.input?.generation) !== saved.input?.generationDigest
    )
      throw new Error("Attempt review snapshot integrity mismatch");
    return saved.input as AttemptReviewPrInput;
  }
  private async reviewReceipt(runId: number, attemptId: string) {
    const saved = await this.store.state<Json>(
      this.receiptPath(runId, attemptId),
    );
    if (!saved) return null;
    if (
      saved.schema_version !== 1 ||
      saved.repository !== this.config.repository ||
      saved.run_id !== runId ||
      saved.attempt_id !== attemptId ||
      digest(saved.receipt) !== saved.receipt_digest ||
      saved.receipt?.runId !== runId ||
      saved.receipt?.attemptId !== attemptId ||
      saved.receipt?.repository !== this.config.repository ||
      !Number.isSafeInteger(saved.receipt?.pr) ||
      saved.receipt.pr < 1 ||
      typeof saved.receipt?.url !== "string" ||
      saved.receipt.url.toLowerCase() !==
        `https://github.com/${this.config.repository}/pull/${saved.receipt.pr}`.toLowerCase() ||
      saved.receipt?.generationDigest !== saved.generation_digest
    )
      throw new Error("Attempt review PR receipt integrity mismatch");
    const snapshot = await this.reviewSnapshot(runId, attemptId);
    if (!snapshot || snapshot.generationDigest !== saved.generation_digest)
      throw new Error(
        "Attempt review receipt has no matching captured generation",
      );
    return {
      ...saved.receipt,
      number: saved.receipt.pr,
      ...(await this.currentReviewMetadata(saved.receipt, snapshot)),
    };
  }
  private async currentReviewMetadata(
    receipt: Json,
    snapshot: AttemptReviewPrInput,
  ) {
    const key = digest(receipt),
      cached = this.reviewMetadata.get(key);
    if (cached && Date.now() - cached.at < 15000) return cached.value;
    const value = (async () => {
      try {
        const pr = await this.client.rest<Json>("GET", `pulls/${receipt.pr}`);
        const repositoryId = Number(snapshot.comparison.repository_id);
        if (
          pr.number !== receipt.pr ||
          pr.html_url !== receipt.url ||
          pr.head?.repo?.id !== repositoryId ||
          pr.base?.repo?.id !== repositoryId ||
          pr.head?.repo?.full_name?.toLowerCase() !==
            this.config.repository.toLowerCase() ||
          pr.base?.repo?.full_name?.toLowerCase() !==
            this.config.repository.toLowerCase() ||
          pr.head?.ref !== receipt.headBranch ||
          pr.base?.ref !== receipt.baseBranch ||
          pr.head?.sha !== receipt.headSha ||
          pr.base?.sha !== receipt.baseSha ||
          !["open", "closed"].includes(pr.state) ||
          typeof pr.draft !== "boolean"
        )
          throw new Error(
            "Current PR metadata does not match the recorded repository and frozen review branches",
          );
        return {
          state: pr.state,
          draft: pr.draft,
          mergedAt: pr.merged_at ?? null,
          provenanceVerified: true,
          metadataError: null,
        };
      } catch (error) {
        return {
          state: "unknown",
          draft: null,
          mergedAt: null,
          provenanceVerified: false,
          metadataError: this.safe(error),
        };
      }
    })();
    this.reviewMetadata.set(key, { at: Date.now(), value });
    return value;
  }
  private async withReviewPrs(runId: number, detail: Json) {
    if (!Array.isArray(detail.attempts) || !detail.attempts.length)
      return detail;
    const available = new Set(await this.archivedFiles(`review-prs/${runId}`));
    return {
      ...detail,
      attempts: await Promise.all(
        detail.attempts.map(async (attempt: Json) => ({
          ...attempt,
          reviewPr: available.has(`${sha256(attempt.id)}.json`)
            ? await this.reviewReceipt(runId, attempt.id)
            : null,
        })),
      ),
    };
  }
  async reviewAttempt(runId: number, attemptId: string) {
    if (
      !Number.isSafeInteger(runId) ||
      runId < 1 ||
      typeof attemptId !== "string" ||
      !/^[a-zA-Z0-9._-]{1,200}$/.test(attemptId)
    )
      throw new Error("Invalid recorded attempt identity");
    if (this.closing || this.workerError)
      throw new Error("Dashboard worker is unavailable");
    if (this.postgres) await this.postgres.assertWorker();
    const key = `${runId}/${attemptId}`;
    let pending = this.reviewPublishes.get(key);
    if (!pending) {
      pending = (async () => {
        const detail = (await this.run(runId)) as Json;
        const attempt = detail.attempts?.find(
          (entry: Json) => entry.id === attemptId,
        );
        if (
          !attempt ||
          !attempt.changes?.captured ||
          !attempt.changes.files?.length
        )
          throw new Error(
            "This recorded attempt has no captured file changes to publish",
          );
        const existing = await this.reviewReceipt(runId, attemptId);
        if (existing) return existing;
        let input = await this.reviewSnapshot(runId, attemptId);
        if (!input) {
          await this.run(runId, true);
          input = await this.reviewSnapshot(runId, attemptId);
        }
        if (!input)
          throw new Error(
            "The original captured attempt artifacts are unavailable; a review PR cannot be reconstructed safely",
          );
        if (this.closing || this.workerError)
          throw new Error("Dashboard worker is unavailable");
        if (this.postgres) await this.postgres.assertWorker();
        const receipt = await createAttemptReviewPr(this.config, input);
        await this.store.immutable(this.receiptPath(runId, attemptId), {
          schema_version: 1,
          repository: this.config.repository,
          run_id: runId,
          attempt_id: attemptId,
          generation_digest: input.generationDigest,
          receipt,
          receipt_digest: digest(receipt),
        });
        return this.reviewReceipt(runId, attemptId);
      })();
      this.reviewPublishes.set(key, pending);
      pending.catch(() => this.reviewPublishes.delete(key));
    }
    await pending;
    return this.reviewReceipt(runId, attemptId);
  }
  async start(value: StartInput) {
    if (this.closing || this.workerError)
      throw new Error(
        this.workerError ??
          "Dashboard worker is stopping; no new jobs are accepted",
      );
    if (this.postgres) await this.postgres.assertWorker();
    const input = validateStartInput(value);
    await this.loadQueue();
    if (input.model) {
      const catalog = await this.models();
      if (catalog.modelError) throw new Error(catalog.modelError);
      if (!catalog.models.some((m) => m.id === input.model))
        throw new Error(
          "Model is not listed for the configured OpenAI account",
        );
    }
    const inputDigest = digest(input);
    const existing = this.queue.find(
      (job) =>
        job.inputDigest === inputDigest &&
        !["completed", "failed"].includes(job.status),
    );
    if (existing)
      return {
        jobId: existing.jobId,
        status: existing.status,
        runId: existing.runId ?? null,
      };
    if (
      this.queue.filter((job) => !["completed", "failed"].includes(job.status))
        .length >= 100
    )
      throw new Error("Dashboard queue is full");
    const now = new Date().toISOString();
    const job: QueueJob = {
      jobId: randomUUID(),
      name: input.name ?? `PR #${input.pr}`,
      status: "queued",
      input: structuredClone(input),
      inputDigest,
      createdAt: now,
      updatedAt: now,
    };
    if (this.closing || this.workerError)
      throw new Error("Dashboard worker is stopping; no new jobs are accepted");
    if (this.postgres) await this.postgres.assertWorker();
    this.pendingSubmissions.add(job.jobId);
    this.queue.push(job);
    try {
      await this.saveQueue();
    } catch (error) {
      this.queue = this.queue.filter((entry) => entry !== job);
      throw error;
    } finally {
      this.pendingSubmissions.delete(job.jobId);
    }
    return { jobId: job.jobId, status: job.status };
  }
  private async prepare(input: StartInput) {
    let pr = input.pr,
      directory: string | undefined;
    try {
      if (!pr) {
        const overlay = [...(input.skills ?? [])];
        if (input.instructions !== undefined)
          overlay.push({ path: "AGENTS.md", content: input.instructions });
        if (overlay.length) {
          directory = await mkdtemp(join(tmpdir(), "fullbeam-dashboard-"));
          for (const file of overlay) {
            const path = join(directory, file.path);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, file.content, { mode: 0o600 });
          }
        }
        const proposal = await createHarnessProposal(this.config, {
          name: input.name!,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          overlayDir: directory,
        });
        pr = proposal.pr;
      }
      const head = await defaultHead(this.client);
      const [branch, pull] = await Promise.all([
        this.client.rest<{ protected: boolean }>(
          "GET",
          `branches/${encodeURIComponent(head.branch)}`,
        ),
        this.client.rest<Json>("GET", `pulls/${pr}`),
      ]);
      if (
        !head.private ||
        !branch.protected ||
        pull.state !== "open" ||
        pull.head.repo?.id !== head.id ||
        pull.base.repo?.id !== head.id ||
        pull.base.ref !== head.branch
      )
        throw new Error(
          "Comparison requires an open same-repository PR and protected private default branch",
        );
      return { pr, head };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
