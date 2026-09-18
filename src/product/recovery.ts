import { join } from "node:path";
import { GitHubClient, GitHubActions } from "../github/index.js";
import { InstacloudExecutor, branchName } from "../execution/instacloud.js";
import { EvidenceStore } from "../core/store.js";
import { digest } from "../core/integrity.js";
import type { JournalEvent, ResourceRecord } from "../core/checkpoints.js";
import { readArtifactJson } from "./actions.js";
import { defaultHead, readRepoJson } from "./github-context.js";
import type { RuntimeLock } from "./types.js";
export interface RecoveryConfig {
  githubToken: string;
  repository: string;
  instacloudToken: string;
  orgId: string;
  region: string;
  stateDir: string;
}
export async function recover(
  config: RecoveryConfig,
  runId: number,
  dependencies: { fetch?: typeof globalThis.fetch } = {},
): Promise<{ deleted: number; failed: number }> {
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("Recovery requires a real Actions run ID");
  const [owner, repo] = config.repository.split("/");
  const client = new GitHubClient({
    token: config.githubToken,
    repository: { owner: owner!, repo: repo! },
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  const run = await client.rest<{
    repository: { full_name: string };
    head_sha: string;
    event: string;
    status: string;
    path: string;
  }>("GET", `actions/runs/${runId}`);
  if (
    run.repository.full_name.toLowerCase() !==
      config.repository.toLowerCase() ||
    run.event !== "workflow_dispatch" ||
    !run.path.split("@")[0]!.endsWith("/fullbeam-compare.yml")
  )
    throw new Error(
      "Recovery is restricted to recorded Fullbeam workflow runs",
    );
  const runtime = await readRepoJson<RuntimeLock>(
    client,
    ".fullbeam/runtime.lock.json",
    run.head_sha,
  );
  const actions = new GitHubActions(client);
  const allArtifacts = await actions.listRunArtifacts(runId);
  const recordedArtifacts = allArtifacts.filter((a) =>
    a.name.startsWith("fb-resource-"),
  );
  if (recordedArtifacts.some((a) => a.expired))
    throw new Error(
      "Resource journal artifacts expired; cleanup is UNCONFIRMED and requires retained private evidence",
    );
  const artifacts = recordedArtifacts;
  const events: JournalEvent[] = [];
  for (const a of artifacts) {
    const downloaded = await actions.downloadRunArtifact(runId, a.name);
    const match = a.name.match(/-(\d+)-([a-f0-9]{10})$/);
    if (!match) throw new Error("Malformed resource journal artifact name");
    const e = readArtifactJson<JournalEvent>(
      downloaded.zip,
      `${match[1]}.json`,
    );
    if (digest(e).slice(0, 10) !== match[2] || e.sequence !== Number(match[1]))
      throw new Error("Resource journal artifact integrity mismatch");
    events.push(e);
  }
  const pending = reconcileResourceEvents(events, runtime, runId);
  const executor = new InstacloudExecutor({
    apiKey: config.instacloudToken,
    orgId: config.orgId,
    generationProjectId: runtime.projects.generation,
    verifierProjectId: runtime.projects.verification,
    region: runtime.region,
    runtimeImages: runtime.images,
  });
  let deleted = 0,
    failed = 0;
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  try {
    for (const environment of pending) {
      try {
        await executor.destroy(environment);
        deleted++;
      } catch {
        failed++;
      }
    }
    await store.saveState(`recovery/${runId}.json`, {
      run_id: runId,
      at: new Date().toISOString(),
      deleted,
      failed,
      recorded_resources: pending.length,
    });
  } finally {
    await executor.close();
  }
  return { deleted, failed };
}
export function reconcileResourceEvents(
  events: JournalEvent[],
  runtime: RuntimeLock,
  runId: number,
): ResourceRecord[] {
  const unique = new Map<string, JournalEvent>();
  for (const event of events) {
    const qualification =
      event.run_id === `qualify-${runId}` ||
      new RegExp(`^qualify-${runId}-[1-9][0-9]*$`).test(event.run_id);
    if (!qualification && !event.run_id.startsWith(`${runId}-`))
      throw new Error("Resource journal run identity mismatch");
    if (
      event.schema_version !== 1 ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      !["INTENT", "ALLOCATED", "DELETED", "CLEANUP_FAILED"].includes(
        event.kind,
      ) ||
      !event.environment ||
      !["generation", "verification"].includes(event.environment.role)
    )
      throw new Error("Malformed resource journal event");
    const key = `${event.run_id}/${event.sequence}`,
      prior = unique.get(key);
    if (prior && digest(prior) !== digest(event))
      throw new Error(
        "Conflicting journal sequence claims; cleanup is UNCONFIRMED",
      );
    unique.set(key, event);
  }
  const pending = new Map<string, ResourceRecord>();
  const ordered = [...unique.values()].sort(
    (a, b) => a.run_id.localeCompare(b.run_id) || a.sequence - b.sequence,
  );
  for (const e of ordered) {
    const expected =
      e.environment.role === "generation"
        ? runtime.projects.generation
        : runtime.projects.verification;
    if (
      e.environment.projectId !== expected ||
      e.environment.branch !== branchName(e.environment.id)
    )
      throw new Error("Journal environment escaped recorded template identity");
    const key = `${expected}/${e.environment.branch}`;
    if (e.kind === "DELETED") pending.delete(key);
    else pending.set(key, e.environment);
  }
  return [...pending.values()];
}
export async function sweep(config: RecoveryConfig): Promise<void> {
  const [owner, repo] = config.repository.split("/");
  const client = new GitHubClient({
    token: config.githubToken,
    repository: { owner: owner!, repo: repo! },
  });
  for (let page = 1; page <= 10; page++) {
    const response = await client.rest<{
      workflow_runs: { id: number; status: string; created_at: string }[];
    }>(
      "GET",
      `actions/workflows/fullbeam-compare.yml/runs?per_page=100&page=${page}`,
    );
    for (const run of response.workflow_runs) {
      if (
        run.status === "completed" &&
        Date.now() - Date.parse(run.created_at) < 30 * 86400000
      ) {
        const result = await recover(config, run.id);
        console.log(
          `Recovery ${run.id}: ${result.deleted} deleted, ${result.failed} unresolved`,
        );
        if (result.failed) process.exitCode = 1;
      }
    }
    if (response.workflow_runs.length < 100) break;
  }
}
