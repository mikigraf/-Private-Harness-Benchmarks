import { secretsOf, type Config } from "../core/config.js";
import {
  digest,
  manifestDigest,
  overlayFiles,
  validateBundle,
  type FileEntry,
} from "../core/integrity.js";
import { validateRecord, type Comparison } from "../core/records.js";
import type { ArtifactManifest } from "../execution/types.js";
import {
  GitHubApiError,
  freezeSourceTree,
  type GitHubClient,
} from "../github/index.js";
import type { ComparisonResolvedHarness } from "../harness/resolve.js";
import { fromGitFiles } from "./files.js";
import { defaultHead, github } from "./github-context.js";
import type { RunEnvelope } from "./types.js";

/** Only server-verified immutable evidence may populate this input. No browser file payloads. */
export interface AttemptReviewPrInput {
  comparison: Comparison;
  envelope: RunEnvelope;
  taskSource: FileEntry[];
  release: ComparisonResolvedHarness;
  generation: ArtifactManifest;
  generationDigest: string;
}
export interface AttemptReviewPrReceipt {
  schema_version: 1;
  repository: string;
  runId: number;
  comparisonId: string;
  attemptId: string;
  generationDigest: string;
  pr: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
}
interface Dependencies {
  client?: GitHubClient;
}
interface Pull {
  number: number;
  html_url: string;
  body: string | null;
  draft: boolean;
  user: { login: string };
  head: { ref: string; sha: string; repo: { id: number } | null };
  base: { ref: string; sha: string; repo: { id: number } | null };
}
const ordered = <T extends { path: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const manifest = (files: FileEntry[]) =>
  ordered(files.map(({ content: _, ...file }) => file));
const gitManifest = (files: FileEntry[]) =>
  manifestDigest(
    files.map((file) => ({
      ...file,
      mode: file.mode & 0o111 ? 0o100755 : 0o100644,
    })),
  );

function assertPublishable(
  before: FileEntry[],
  after: FileEntry[],
  config: Config,
): void {
  validateBundle(before);
  validateBundle(after);
  const prior = new Map(before.map((file) => [file.path, file])),
    next = new Map(after.map((file) => [file.path, file]));
  const secrets = secretsOf(config)
    .filter(Boolean)
    .map((secret) => Buffer.from(secret));
  for (const file of [...before, ...after]) {
    const parts = file.path.toLowerCase().split("/"),
      name = parts.at(-1)!;
    // Historical captures selected nested controller AGENTS.md as harness instructions.
    // Those inert frozen bytes are safe only when present and unchanged on both sides.
    const historicalAgent =
      file.path.startsWith(".fullbeam/") &&
      file.path.endsWith("/AGENTS.md") &&
      prior.get(file.path)?.sha256 === next.get(file.path)?.sha256 &&
      prior.get(file.path)?.mode === next.get(file.path)?.mode;
    if (
      parts.includes(".github") ||
      parts.includes(".git") ||
      (parts.includes(".fullbeam") && !historicalAgent) ||
      parts.some((part) =>
        [".ssh", ".aws", ".azure", ".gnupg", ".kube"].includes(part),
      ) ||
      /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/.test(
        name,
      ) ||
      /\.(?:pem|key|p12|pfx|keystore)$/.test(name)
    )
      throw new Error(
        "Captured bundle contains an unsafe infrastructure or credential path; cannot publish exact patch",
      );
    const bytes = Buffer.from(file.content, "base64");
    if (
      secrets.some(
        (secret) =>
          bytes.includes(secret) || Buffer.from(file.path).includes(secret),
      )
    )
      throw new Error(
        "Captured bundle contains configured secret bytes; exact patch cannot be published",
      );
  }
}

function validateInput(config: Config, input: AttemptReviewPrInput) {
  const {
    comparison,
    envelope: { slot, run },
    release,
    generation,
  } = input;
  validateRecord(comparison);
  validateRecord(run);
  validateRecord(release.release);
  const runId = Number(comparison.github_actions_run_id);
  const releaseDigest =
    slot.release_id === "current"
      ? comparison.current_release_digest
      : slot.release_id === "candidate"
        ? comparison.candidate_release_digest
        : null;
  const scheduled = comparison.schedule.filter(
    (row) =>
      row.task_id === slot.task_id &&
      row.release_id === slot.release_id &&
      row.repeat === slot.repeat &&
      row.block_id === slot.block_id &&
      row.order === slot.order,
  );
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    String(runId) !== comparison.github_actions_run_id ||
    scheduled.length !== 1 ||
    run.id !== slot.id ||
    run.comparison_id !== comparison.id ||
    run.task_digest !== slot.task_digest ||
    run.release_digest !== slot.release_digest ||
    run.repeat !== slot.repeat ||
    run.block_id !== slot.block_id ||
    releaseDigest !== slot.release_digest ||
    release.release.digest !== releaseDigest ||
    release.release.id !== slot.release_id ||
    release.release.source_commit !==
      (slot.release_id === "current"
        ? comparison.baseline_source_sha
        : comparison.candidate_head_sha)
  )
    throw new Error(
      "Attempt review input does not match the frozen comparison slot and release",
    );
  if (
    !generation.integrityVerified ||
    generation.role !== "generation" ||
    digest(generation) !== input.generationDigest ||
    !run.artifacts.some(
      (ref) =>
        ref.id === input.generationDigest &&
        ref.sha256 === input.generationDigest &&
        ref.media_type === "application/json",
    )
  )
    throw new Error(
      "Generation artifact integrity or attempt binding is invalid",
    );
  validateBundle(input.taskSource);
  validateBundle(release.files);
  if (
    digest(
      ordered(release.files.map(({ path, sha256 }) => ({ path, sha256 }))),
    ) !== digest(ordered(release.release.native_files))
  )
    throw new Error("Frozen release files do not match release manifest");
  const before = overlayFiles(input.taskSource, release.files),
    after = generation.files;
  assertPublishable(before, after, config);
  if (digest(manifest(before)) !== digest(ordered(generation.beforeManifest)))
    throw new Error(
      "Generation before manifest differs from the frozen task and harness",
    );
  if (digest(manifest(after)) !== digest(ordered(generation.afterManifest)))
    throw new Error("Generation after manifest differs from captured files");
  if (gitManifest(before) === gitManifest(after))
    throw new Error(
      "The selected attempt has no captured Git changes to review",
    );
  return { before, after, runId };
}

async function readRef(
  client: GitHubClient,
  branch: string,
): Promise<string | null> {
  try {
    return (
      await client.rest<{ object: { sha: string } }>(
        "GET",
        `git/ref/heads/${encodeURIComponent(branch)}`,
      )
    ).object.sha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}
async function verifyCommit(
  client: GitHubClient,
  sha: string,
  files: FileEntry[],
  message: string,
  parents: string[],
  actor: string,
) {
  const commit = await client.rest<{
    sha: string;
    author: { login: string } | null;
    commit: { message: string };
    parents: { sha: string }[];
  }>("GET", `commits/${sha}`);
  if (
    commit.sha !== sha ||
    commit.author?.login !== actor ||
    commit.commit.message !== message ||
    digest(commit.parents.map((parent) => parent.sha)) !== digest(parents)
  )
    throw new Error(
      "Attempt review branch ownership or snapshot ancestry changed",
    );
  const tree = await freezeSourceTree(client, sha);
  if (gitManifest(fromGitFiles(tree.files)) !== gitManifest(files))
    throw new Error("Attempt review branch snapshot content changed");
}
async function createCommit(
  client: GitHubClient,
  files: FileEntry[],
  message: string,
  parents: string[],
): Promise<string> {
  const tree = [];
  for (const file of files) {
    const blob = await client.rest<{ sha: string }>("POST", "git/blobs", {
      content: file.content,
      encoding: "base64",
    });
    tree.push({
      path: file.path,
      mode: file.mode & 0o111 ? "100755" : "100644",
      type: "blob",
      sha: blob.sha,
    });
  }
  // A complete tree, without base_tree, captures deletions and never inherits controller workflows.
  const created = await client.rest<{ sha: string }>("POST", "git/trees", {
    tree,
  });
  return (
    await client.rest<{ sha: string }>("POST", "git/commits", {
      message,
      tree: created.sha,
      parents,
    })
  ).sha;
}
async function createRef(
  client: GitHubClient,
  branch: string,
  sha: string,
): Promise<void> {
  // No force update or ref update is permitted. A competing publisher is verified by its exact snapshot below.
  try {
    await client.rest("POST", "git/refs", { ref: `refs/heads/${branch}`, sha });
  } catch (error) {
    if (
      !(error instanceof GitHubApiError) ||
      error.status !== 422 ||
      !(await readRef(client, branch))
    )
      throw error;
  }
}

/** Publish only on an explicit user action. One immutable task snapshot and exact captured output, never main/configuration PR. */
export async function createAttemptReviewPr(
  config: Config,
  input: AttemptReviewPrInput,
  dependencies: Dependencies = {},
): Promise<AttemptReviewPrReceipt> {
  const { before, after, runId } = validateInput(config, input);
  const client = dependencies.client ?? github(config),
    {
      comparison,
      envelope: { slot, run },
      release,
    } = input;
  if (
    `${client.repository.owner}/${client.repository.repo}`.toLowerCase() !==
    config.repository.toLowerCase()
  )
    throw new Error(
      "Attempt review client is outside the authorized repository",
    );
  const repo = await defaultHead(client);
  if (
    !repo.private ||
    String(repo.id) !== comparison.repository_id ||
    (client.repository.repositoryId !== undefined &&
      client.repository.repositoryId !== repo.id)
  )
    throw new Error(
      "Attempt review requires the comparison's authorized private repository",
    );
  if (
    !(
      await client.rest<{ protected: boolean }>(
        "GET",
        `branches/${encodeURIComponent(repo.branch)}`,
      )
    ).protected
  )
    throw new Error(
      "Default branch must be protected before publishing attempt reviews",
    );
  const actor = await client.authenticatedActor();
  const identity = digest({
    comparison: digest(comparison),
    run: digest(run),
    generation: input.generationDigest,
    source: manifestDigest(before),
    output: manifestDigest(after),
  });
  const prefix = `fullbeam/attempt/${runId}/${identity.slice(0, 32)}`,
    baseBranch = `${prefix}/base`,
    headBranch = `${prefix}/changes`,
    marker = `<!-- fullbeam:attempt-review:${identity} -->`;
  const baseMessage = `Fullbeam frozen task snapshot\n\n${marker}`,
    headMessage = `Fullbeam captured attempt output\n\n${marker}`;
  const provenance = {
    comparison_id: comparison.id,
    attempt_id: run.id,
    task_id: slot.task_id,
    task_digest: slot.task_digest,
    release: slot.release_id,
    release_digest: slot.release_digest,
    model: release.release.requested_model,
    reasoning_effort: release.settings.model_reasoning_effort ?? null,
    repeat: slot.repeat,
    outcome: run.outcome,
    generation_artifact_sha256: input.generationDigest,
    source_manifest_sha256: manifestDigest(before),
    output_manifest_sha256: manifestDigest(after),
    configuration_pr: comparison.candidate_pr,
    configuration_head: comparison.candidate_head_sha,
  };
  const urlBase = `https://github.com/${config.repository}`;
  const body = [
    marker,
    "",
    "Captured model output for one benchmark attempt. This draft is for code review; its base is the exact frozen task and harness snapshot, separate from the repository default branch and configuration proposal.",
    "",
    `Benchmark run: ${urlBase}/actions/runs/${runId}`,
    `Configuration proposal: ${urlBase}/pull/${comparison.candidate_pr}`,
    "",
    `Observed outcome: **${run.outcome}**. Publication does not change the recorded benchmark outcome or qualify the release for production.`,
    "",
    "The diff preserves captured bytes, deletions, executable modes, and any protected public-test edits. It includes no hidden reference implementation, verifier, runtime logs, or controller secrets.",
    "",
    "```json",
    JSON.stringify(provenance, null, 2)
      .replaceAll("`", "\\u0060")
      .replaceAll("<", "\\u003c"),
    "```",
  ].join("\n");
  if (
    secretsOf(config)
      .filter(Boolean)
      .some((secret) => body.includes(secret))
  )
    throw new Error(
      "Attempt provenance contains configured secret bytes; cannot publish",
    );
  let baseSha = await readRef(client, baseBranch),
    headSha = await readRef(client, headBranch);
  if (headSha && !baseSha)
    throw new Error(
      "Attempt review head exists without its owned snapshot base",
    );
  if (baseSha)
    await verifyCommit(client, baseSha, before, baseMessage, [], actor.login);
  if (headSha)
    await verifyCommit(
      client,
      headSha,
      after,
      headMessage,
      [baseSha!],
      actor.login,
    );
  if (!baseSha) {
    await createRef(
      client,
      baseBranch,
      await createCommit(client, before, baseMessage, []),
    );
    baseSha = await readRef(client, baseBranch);
    if (!baseSha) throw new Error("Attempt review base ref was not created");
    await verifyCommit(client, baseSha, before, baseMessage, [], actor.login);
  }
  if (!headSha) {
    await createRef(
      client,
      headBranch,
      await createCommit(client, after, headMessage, [baseSha]),
    );
    headSha = await readRef(client, headBranch);
    if (!headSha) throw new Error("Attempt review head ref was not created");
    await verifyCommit(
      client,
      headSha,
      after,
      headMessage,
      [baseSha],
      actor.login,
    );
  }
  const findPull = () =>
    client.paginate<Pull>("pulls", {
      state: "all",
      head: `${client.repository.owner}:${headBranch}`,
      per_page: 100,
    });
  let pulls = await findPull();
  if (!pulls.length) {
    try {
      pulls = [
        await client.rest<Pull>("POST", "pulls", {
          title:
            `[Fullbeam ${runId}] ${release.release.requested_model}: ${slot.task_id} (${slot.release_id}, repeat ${slot.repeat})`.slice(
              0,
              240,
            ),
          body,
          head: headBranch,
          base: baseBranch,
          draft: true,
          maintainer_can_modify: false,
        }),
      ];
    } catch (error) {
      // Creation may have succeeded before a transient response failure. Recover only an exact owned PR.
      pulls = await findPull();
      if (!pulls.length) throw error;
    }
  }
  if (pulls.length !== 1)
    throw new Error("Ambiguous attempt review pull request ownership");
  const pull = pulls[0]!;
  if (
    pull.number === comparison.candidate_pr ||
    pull.user.login !== actor.login ||
    pull.body !== body ||
    pull.head.ref !== headBranch ||
    pull.head.sha !== headSha ||
    pull.head.repo?.id !== repo.id ||
    pull.base.ref !== baseBranch ||
    pull.base.sha !== baseSha ||
    pull.base.repo?.id !== repo.id ||
    // Exact URL equality also rejects credentials, query strings, fragments, ports, and other hosts.
    pull.html_url.toLowerCase() !==
      `${urlBase}/pull/${pull.number}`.toLowerCase() ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1
  )
    throw new Error(
      "Attempt review pull request ownership or frozen source binding changed",
    );
  if (
    (await readRef(client, baseBranch)) !== baseSha ||
    (await readRef(client, headBranch)) !== headSha
  )
    throw new Error("Attempt review refs changed during publication");
  return {
    schema_version: 1,
    repository: config.repository,
    runId,
    comparisonId: comparison.id,
    attemptId: run.id,
    generationDigest: input.generationDigest,
    pr: pull.number,
    url: pull.html_url,
    baseBranch,
    headBranch,
    baseSha,
    headSha,
  };
}
