import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type Config, redact, secretsOf } from "../core/config.js";
import { canonical, digest } from "../core/integrity.js";
import { GitHubClient, GitHubPublisher } from "../github/index.js";
import { github, defaultHead } from "./github-context.js";
import { qualify } from "./qualification.js";
import { compare } from "./comparison.js";
import { renderReport } from "./report.js";
export interface Publication {
  schema_version: 1;
  repository: string;
  pr: number;
  head: string;
  reportText: string;
  execution: "success" | "failure";
  evidence: "neutral" | "failure";
  run_id: string;
  report_hash: string | null;
  outdated: boolean;
}
export function assertFirstWorkflowAttempt(value: string | undefined): void {
  const attempt = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("Invalid GitHub Actions run attempt");
  if (attempt > 1)
    throw new Error(
      "GitHub Actions reruns are unsupported because run artifacts are immutable; dispatch a fresh comparison linked with --previous",
    );
}
function incompletePublication(
  config: Config,
  pr: number,
  head: string,
  runId: string,
  detail: string,
): Publication {
  return {
    schema_version: 1,
    repository: config.repository,
    pr,
    head,
    reportText: `Fullbeam execution INCOMPLETE\nCandidate PR #${pr}; frozen head ${head}\nNo completed comparison is claimed.\n${detail}\nSee Actions run ${runId} and cleanup recovery artifacts.\nNOT_QUALIFIED_FOR_PRODUCTION`,
    execution: "failure",
    evidence: "neutral",
    run_id: runId,
    report_hash: null,
    outdated: false,
  };
}
async function persistPublication(
  config: Config,
  publication: Publication,
): Promise<void> {
  await mkdir(join(config.stateDir, "publication"), { recursive: true });
  await writeFile(
    join(config.stateDir, "publication", "publication.json"),
    canonical(publication),
    { mode: 0o600 },
  );
}
export async function controller(
  config: Config,
  options: {
    operation: "compare" | "qualify";
    pr?: number;
    trigger: string;
    previous?: string;
  },
): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.GITHUB_RUN_ID ||
    !process.env.GITHUB_SHA
  )
    throw new Error(
      "Comparisons and qualification run only in the trusted GitHub Actions controller",
    );
  assertFirstWorkflowAttempt(process.env.GITHUB_RUN_ATTEMPT);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(options.trigger))
    throw new Error("Invalid trigger identity");
  const client = github(config);
  const repo = await defaultHead(client);
  const branch = await client.rest<{ protected: boolean }>(
    "GET",
    `branches/${encodeURIComponent(repo.branch)}`,
  );
  if (
    process.env.GITHUB_REF !== `refs/heads/${repo.branch}` ||
    !branch.protected
  )
    throw new Error(
      "Trusted workflow must dispatch from protected default branch",
    );
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (checkedOut !== process.env.GITHUB_SHA)
    throw new Error("Controller checkout does not match dispatched commit");
  const handler = () => {
    process.exitCode = 130;
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  let publication: Publication | undefined;
  let frozenCandidateHead: string | undefined;
  try {
    if (options.operation === "qualify") {
      const output = await qualify(config, checkedOut);
      await mkdir(join(config.stateDir, "qualification"), { recursive: true });
      await writeFile(
        join(config.stateDir, "qualification", "qualification.json"),
        canonical(output),
        { mode: 0o600 },
      );
      console.log(
        `Calibration complete; pending qualification finalization: ${output.approval_digest}`,
      );
    } else {
      if (!options.pr) throw new Error("Candidate PR required");
      const pull = await client.rest<{ head: { sha: string } }>(
        "GET",
        `pulls/${options.pr}`,
      );
      frozenCandidateHead = pull.head.sha;
      publication = incompletePublication(
        config,
        options.pr,
        frozenCandidateHead,
        process.env.GITHUB_RUN_ID,
        "Comparison started; no final outcome is available yet.",
      );
      await persistPublication(config, publication);
      const report = await compare(
        config,
        options.pr,
        checkedOut,
        options.trigger,
        options.previous ?? null,
        frozenCandidateHead,
      );
      const text = renderReport(report);
      publication = {
        schema_version: 1,
        repository: config.repository,
        pr: options.pr,
        head: report.comparison.candidate_head_sha,
        reportText: text,
        execution:
          report.summary.execution_completeness === "COMPLETE" &&
          report.cleanup_status === "CONFIRMED"
            ? "success"
            : "failure",
        evidence: report.summary.comparison_findings.some(
          (f) => f.risk === "CRITICAL" && f.finding === "REGRESSION_OBSERVED",
        )
          ? "failure"
          : "neutral",
        run_id: process.env.GITHUB_RUN_ID,
        report_hash: report.report_hash,
        outdated: report.applicability === "OUTDATED",
      };
      if (publication.execution === "failure") process.exitCode = 1;
      if (process.env.GITHUB_STEP_SUMMARY)
        await writeFile(
          process.env.GITHUB_STEP_SUMMARY,
          `<pre>${escapeText(text)}</pre>\n`,
        );
    }
  } catch (error) {
    if (options.operation === "compare" && options.pr && frozenCandidateHead)
      publication = incompletePublication(
        config,
        options.pr,
        frozenCandidateHead,
        process.env.GITHUB_RUN_ID,
        redact(String(error), secretsOf(config)),
      );
    throw error;
  } finally {
    if (publication) await persistPublication(config, publication);
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
}
function escapeText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
export async function publish(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY)
    throw new Error("Publishing requires the repository-scoped Actions token");
  const value = JSON.parse(await readFile(file, "utf8")) as Publication;
  if (
    value.schema_version !== 1 ||
    value.repository !== env.GITHUB_REPOSITORY ||
    !Number.isSafeInteger(value.pr) ||
    value.pr < 1 ||
    !/^[a-f0-9]{40}$/.test(value.head) ||
    value.run_id !== env.GITHUB_RUN_ID
  )
    throw new Error("Invalid publication identity");
  if (
    typeof value.reportText !== "string" ||
    Buffer.byteLength(value.reportText) > 60000 ||
    !["success", "failure"].includes(value.execution) ||
    !["neutral", "failure"].includes(value.evidence)
  )
    throw new Error("Invalid publication payload");
  const [owner, repo] = value.repository.split("/");
  const client = new GitHubClient({
    token: env.GITHUB_TOKEN,
    repository: { owner: owner!, repo: repo! },
  });
  const publisher = new GitHubPublisher(client);
  const detailsUrl = `https://github.com/${value.repository}/actions/runs/${value.run_id}`;
  const common = {
    pullNumber: value.pr,
    expectedHeadSha: value.head,
    title: "Fullbeam comparison evidence",
    reportText: value.reportText,
    allowOutdated: true as const,
  };
  await publisher.publish({
    ...common,
    check: {
      name: "fullbeam / execution",
      conclusion: value.execution,
      detailsUrl,
    },
  });
  const result = await publisher.publish({
    ...common,
    check: {
      name: "fullbeam / evidence",
      conclusion: value.evidence,
      detailsUrl,
    },
  });
  if (env.GITHUB_STEP_SUMMARY)
    await writeFile(env.GITHUB_STEP_SUMMARY, result.jobSummary);
  console.log(result.commentUrl);
}
