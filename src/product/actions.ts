import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { GitHubActions, type GitHubClient } from "../github/index.js";
import { normalizePath } from "../core/integrity.js";
import { defaultHead } from "./github-context.js";
export interface ObservedWorkflowRun {
  id: number;
  display_title: string;
  head_sha: string;
  created_at: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}
export function selectDispatchedRun(
  runs: ObservedWorkflowRun[],
  operation: "compare" | "qualify",
  trigger: string,
  expectedHeadSha: string,
  dispatchedAt: number,
): ObservedWorkflowRun | undefined {
  const correlated = runs.filter(
    (run) =>
      run.display_title === `Fullbeam ${operation} ${trigger}` &&
      Date.parse(run.created_at) >= dispatchedAt - 5000,
  );
  if (correlated.length > 1)
    throw new Error("Ambiguous duplicate workflow trigger");
  const run = correlated[0];
  if (run && run.head_sha !== expectedHeadSha)
    throw new Error(
      `Workflow trigger ran at a different protected commit (${run.head_sha}); the default branch moved after dispatch preparation`,
    );
  return run;
}
export function readArtifactJson<T>(archive: Uint8Array, filename: string): T {
  if (archive.length > 32 * 1024 * 1024)
    throw new Error("Artifact compressed byte limit exceeded");
  let total = 0;
  const files = unzipSync(archive, {
    filter: (f) => {
      normalizePath(f.name.replace(/\/$/, ""));
      total += f.originalSize;
      if (total > 64 * 1024 * 1024 || f.originalSize > 32 * 1024 * 1024)
        throw new Error("Artifact expansion limit exceeded");
      return f.name === filename || f.name.endsWith("/" + filename);
    },
  });
  const matches = Object.entries(files).filter(
    ([name]) => name === filename || name.endsWith("/" + filename),
  );
  if (matches.length !== 1)
    throw new Error(`Expected one ${filename} in artifact`);
  return JSON.parse(Buffer.from(matches[0]![1]).toString()) as T;
}
export async function dispatchAndWait(
  client: GitHubClient,
  operation: "compare" | "qualify",
  pr?: number,
  previous?: string,
): Promise<{ id: number; url: string; conclusion: string | null }> {
  const head = await defaultHead(client);
  const trigger = randomUUID();
  const actions = new GitHubActions(client);
  const protection = await client.rest<{ protected: boolean }>(
    "GET",
    `branches/${encodeURIComponent(head.branch)}`,
  );
  if (!protection.protected)
    throw new Error("Default branch must be protected before evaluation");
  const at = Date.now();
  await actions.dispatchWorkflow({
    workflow: "fullbeam-compare.yml",
    ref: head.branch,
    inputs: {
      operation,
      trigger_id: trigger,
      candidate_pr: pr ? String(pr) : "",
      previous_id: previous ?? "",
    },
  });
  console.log(
    `Dispatched ${operation} (${trigger}); waiting for GitHub Actions. You may stop waiting without cancelling the workflow.`,
  );
  const deadline = Date.now() + 185 * 60_000;
  let printed = 0;
  while (Date.now() < deadline) {
    const response = await client.rest<{
      workflow_runs: ObservedWorkflowRun[];
    }>(
      "GET",
      "actions/workflows/fullbeam-compare.yml/runs?event=workflow_dispatch&per_page=100",
    );
    const run = selectDispatchedRun(
      response.workflow_runs,
      operation,
      trigger,
      head.sha,
      at,
    );
    if (run && printed !== run.id) {
      console.log(run.html_url);
      printed = run.id;
    }
    if (run?.status === "completed")
      return { id: run.id, url: run.html_url, conclusion: run.conclusion };
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    "Workflow wait deadline reached; use the Actions run URL to inspect continuing work",
  );
}
