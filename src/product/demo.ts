import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  GitHubActions,
  GitHubApiError,
  GitHubBootstrap,
  diffFrozenTrees,
  freezeSourceTree,
  type GitHubClient,
} from "../github/index.js";
import { DEFAULT_POLICY, type Config } from "../core/config.js";
import { EvidenceStore, type ArtifactRef } from "../core/store.js";
import {
  canonical,
  digest,
  makeFile,
  manifestDigest,
  type FileEntry,
} from "../core/integrity.js";
import { validateRecord } from "../core/records.js";
import { evaluateCalibration } from "../benchmark/qualify.js";
import { sourcePatchDigest } from "../benchmark/source-patch.js";
import {
  expectedCheckIds,
  materializeFixture,
  seedTasks,
  type RelayDeskStage,
} from "../benchmark/relaydesk.js";
import {
  commitJson,
  defaultHead,
  github,
  readRepoJson,
} from "./github-context.js";
import { APPLICATION_PATHS, fromGitFiles, gitCommitFiles } from "./files.js";
import { graderBundle } from "./grader.js";
import { RemoteController } from "./remote.js";
import { dispatchAndWait, readArtifactJson } from "./actions.js";
import {
  assertTaskQualification,
  finalizeQualificationPackage,
  type QualificationOutput,
} from "./qualification.js";
import type {
  BenchmarkLock,
  DemoState,
  QualificationMode,
  RuntimeLock,
  SeedItem,
} from "./types.js";

export interface QualificationInput {
  repository_id: string;
  source_commit: string;
  runtime_digest: string;
  verification_image: string;
  policy_digest: string;
  verifier_digest: string;
  tasks: Array<{
    id: string;
    issue: number;
    pull_request: number;
    base_sha: string;
    reference_sha: string;
    issue_snapshot_digest: string;
    prompt_digest: string;
    merge_receipt_digest: string;
    definition_digest: string;
    risk: "CRITICAL" | "STANDARD";
    component: string;
    expected_ids: string[];
  }>;
}

export interface StoredQualification {
  schema_version: 1;
  input_digest: string;
  review_url: string;
  output: QualificationOutput;
}

interface StoredSeedReview {
  schema_version: 1;
  task_id: string;
  head_sha: string;
  evidence: ArtifactRef;
}

interface QualificationContext {
  client: GitHubClient;
  head: Awaited<ReturnType<typeof defaultHead>>;
  state: DemoState;
  runtime: RuntimeLock;
  input: QualificationInput;
  store: EvidenceStore;
}

export interface SeedCheckResult {
  status?: string;
  integrityVerified?: boolean;
  violations?: string[];
  buildPassed?: boolean;
  startupPassed?: boolean;
  checks?: Array<{ id: string; status: string }>;
}

interface PullState {
  merged: boolean;
  head: { sha: string };
  merge_commit_sha?: string | null;
}

export interface DemoOptions {
  automated?: boolean;
  approveSeed?: string;
  approveQualification?: string;
  previous?: string;
}

export async function requestReview(
  title: string,
  identity: string,
  provided?: string,
): Promise<boolean> {
  console.log(`${title}\nApproval identity: ${identity}`);
  if (provided !== undefined) return provided === identity;
  if (!stdin.isTTY) {
    console.log(
      "Human review required. Rerun interactively or supply the exact approval identity shown above.",
    );
    return false;
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (
      (
        await terminal.question(
          "After reviewing the evidence, type the complete approval identity: ",
        )
      ).trim() === identity
    );
  } finally {
    terminal.close();
  }
}

export async function reviewSeedCheck(
  item: SeedItem,
  evidence: ArtifactRef,
  result: SeedCheckResult,
  actor: string,
  options: Pick<DemoOptions, "automated" | "approveSeed">,
): Promise<SeedItem | null> {
  if (options.automated && options.approveSeed !== undefined)
    throw new Error(
      "Automated demo cannot also claim explicit human seed approval",
    );
  if (
    !seedTasks.some((task) => task.id === item.id) ||
    !item.head ||
    !actor.trim()
  )
    throw new Error(
      "Seed review requires a known fixture, exact head, and authenticated actor",
    );
  assertPassingSeedCheck(result, item.id);
  if (
    !options.automated &&
    !(await requestReview(
      `Approve the exact seed fix for ${item.id}`,
      item.head,
      options.approveSeed,
    ))
  )
    return null;
  return {
    ...item,
    approved_by: actor,
    review_mode: options.automated ? "AUTOMATED_DEMO" : "HUMAN",
    review_evidence: evidence,
  };
}

export function assertFixtureMatches(
  actual: FileEntry[],
  expected: FileEntry[],
  label: string,
): void {
  const actualFiles = new Map(
    applicationFiles(actual).map((file) => [file.path, file]),
  );
  const expectedFiles = new Map(
    applicationFiles(expected).map((file) => [file.path, file]),
  );
  const paths = [
    ...new Set([...actualFiles.keys(), ...expectedFiles.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  for (const path of paths) {
    const observed = actualFiles.get(path);
    const wanted = expectedFiles.get(path);
    if (
      !observed ||
      !wanted ||
      observed.sha256 !== wanted.sha256 ||
      observed.mode !== wanted.mode
    ) {
      throw new Error(`${label} fixture does not match expected file ${path}`);
    }
  }
}

export function changedFixtureFiles(
  base: FileEntry[],
  reference: FileEntry[],
): FileEntry[] {
  const before = new Map(
    applicationFiles(base).map((file) => [file.path, file]),
  );
  const after = new Map(
    applicationFiles(reference).map((file) => [file.path, file]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  const changed: FileEntry[] = [];
  for (const path of paths) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile?.sha256 === newFile?.sha256 && oldFile?.mode === newFile?.mode)
      continue;
    if (!newFile) throw new Error(`Seed revision unexpectedly deletes ${path}`);
    if (!path.startsWith("src/") && !path.startsWith("tests/public/"))
      throw new Error(
        `Seed revision unexpectedly changes protected fixture file ${path}`,
      );
    changed.push(newFile);
  }
  if (changed.length === 0)
    throw new Error("Seed revision contains no application change");
  return changed;
}

export function recoverSeedMerge(
  remote: SeedItem,
  local: SeedItem | undefined,
  pull: PullState,
): SeedItem {
  if (!pull.merged) return remote;
  if (!local?.merge_receipt || !local.base || !local.reference) {
    throw new Error(
      `Seed PR #${remote.pr ?? "unknown"} was merged without a locally persisted Fullbeam receipt; no receipt will be invented.`,
    );
  }
  const receipt = local.merge_receipt;
  const sameSeed =
    local.id === remote.id &&
    local.issue === remote.issue &&
    local.pr === remote.pr &&
    local.head === remote.head;
  const exactReceipt =
    receipt.mergeMethod === "squash" &&
    receipt.pullNumber === remote.pr &&
    receipt.marker === remote.id &&
    receipt.headSha === remote.head &&
    receipt.mergeCommitSha === pull.merge_commit_sha &&
    receipt.mergeCommitSha === local.reference &&
    receipt.approvedBy === local.approved_by &&
    (receipt.reviewMode ?? "HUMAN") === (local.review_mode ?? "HUMAN");
  if (!sameSeed || !exactReceipt || pull.head.sha !== remote.head)
    throw new Error(
      "Persisted seed merge receipt does not match the live merged pull request",
    );
  return {
    ...remote,
    approved_by: local.approved_by,
    ...(local.review_mode ? { review_mode: local.review_mode } : {}),
    ...(local.review_evidence
      ? { review_evidence: local.review_evidence }
      : {}),
    merge_receipt: receipt,
    base: local.base,
    reference: local.reference,
  };
}

export function qualificationInputDigest(input: QualificationInput): string {
  return digest(input);
}

export function resumeQualification(
  pending: StoredQualification | null,
  input: QualificationInput,
): QualificationOutput | null {
  if (
    !pending ||
    pending.schema_version !== 1 ||
    pending.input_digest !== qualificationInputDigest(input)
  )
    return null;
  validateQualificationOutput(pending.output, input);
  return pending.output;
}

export async function prepareQualification(
  config: Config,
  options: { automated?: boolean } = {},
): Promise<QualificationOutput> {
  const context = await qualificationContext(config);
  const path = pendingQualificationPath(context.input.repository_id);
  const pending = await context.store.state<StoredQualification>(path);
  if (context.state.qualified) {
    if (pending) {
      validateApprovalDigest(pending.output);
      return pending.output;
    }
    throw new Error("Benchmark qualification is already approved");
  }
  const resumed = resumeQualification(pending, context.input);
  if (resumed) {
    console.log(
      `Reusing pending qualification ${resumed.approval_digest}\nReview ${pending!.review_url}`,
    );
    return resumed;
  }
  if (pending) await context.store.saveState(path, null);
  const result = await dispatchAndWait(context.client, "qualify");
  if (result.conclusion !== "success")
    throw new Error(`Qualification workflow did not succeed: ${result.url}`);
  const archive = await new GitHubActions(context.client).downloadRunArtifact(
    result.id,
    `fullbeam-qualification-${result.id}`,
  );
  const qualified = readArtifactJson<QualificationOutput>(
    archive.zip,
    "qualification.json",
  );
  const after = await qualificationContext(config);
  if (
    qualificationInputDigest(after.input) !==
    qualificationInputDigest(context.input)
  )
    throw new Error(
      "Qualification inputs changed while controls were running; the stale result was not retained",
    );
  validateQualificationOutput(qualified, context.input);
  if (qualified.actions_run_id !== String(result.id))
    throw new Error(
      "Qualification artifact belongs to a different Actions run",
    );
  await context.store.saveState(path, {
    schema_version: 1,
    input_digest: qualificationInputDigest(context.input),
    review_url: result.url,
    output: qualified,
  } satisfies StoredQualification);
  console.log(
    `${options.automated ? "Automated demo calibration evidence" : "Qualification evidence is pending explicit review"}: ${result.url}\nApproval identity: ${qualified.approval_digest}`,
  );
  return qualified;
}

export async function approveQualification(
  config: Config,
  output: QualificationOutput,
  approvalDigest: string,
  mode: QualificationMode = "HUMAN",
): Promise<void> {
  if (!approvalDigest || approvalDigest !== output.approval_digest)
    throw new Error(
      "Qualification approval must match the complete displayed digest",
    );
  validateApprovalDigest(output);
  const context = await qualificationContext(config);
  if (
    mode === "HUMAN" &&
    context.state.items.some((item) => item.review_mode === "AUTOMATED_DEMO")
  )
    throw new Error(
      "Automated seed preparation cannot be recorded as human GOLD qualification",
    );
  const approvalPath = ".fullbeam/private/qualification-approval.json";
  if (context.state.qualified) {
    const recorded = await readRepoJson<{ approval_digest: string }>(
      context.client,
      approvalPath,
      context.head.sha,
    );
    if (recorded.approval_digest !== approvalDigest)
      throw new Error(
        "Repository is qualified under a different approval identity",
      );
    if ((context.state.qualification_mode ?? "HUMAN") !== mode)
      throw new Error(
        "Existing qualification mode differs; human review cannot be inferred from automated calibration",
      );
    return;
  }
  const pendingPath = pendingQualificationPath(context.input.repository_id);
  const pending = await context.store.state<StoredQualification>(pendingPath);
  const resumable = resumeQualification(pending, context.input);
  if (
    !resumable ||
    resumable.approval_digest !== output.approval_digest ||
    digest(resumable) !== digest(output)
  )
    throw new Error(
      "Qualification output is not the exact pending result for the current frozen inputs",
    );
  const actor = await context.client.authenticatedActor();
  const approvedAt = new Date().toISOString();
  const qualified = structuredClone(output);
  const files: FileEntry[] = [];
  const lock: BenchmarkLock = {
    schema_version: 1,
    repository_id: context.input.repository_id,
    policy_digest: context.input.policy_digest,
    runtime_digest: context.input.runtime_digest,
    tasks: [],
    dataset_card: {
      origin: "SEEDED_DEMO",
      selection: seedTasks.map((task) => task.id),
      excluded: [],
      exposure: "KNOWN_TO_AUTHORS",
      suite: "SMOKE",
      qualification_mode: mode,
    },
  };
  for (const selected of seedTasks) {
    const pendingPackage = qualified.packages.find(
      (candidate) => candidate.task.id === selected.id,
    )!;
    const taskPackage = finalizeQualificationPackage(
      pendingPackage,
      mode,
      actor.login,
      approvedAt,
    );
    assertTaskQualification(taskPackage, lock);
    const path = `.fullbeam/private/tasks/${selected.id}.json`;
    files.push(makeFile(path, canonical(taskPackage)));
    lock.tasks.push({ id: selected.id, digest: taskPackage.task.digest, path });
  }
  for (const [id, value] of Object.entries(qualified.artifact_objects)) {
    if (digest(value) !== id)
      throw new Error("Qualification artifact content hash mismatch");
    files.push(
      makeFile(`.fullbeam/private/artifacts/${id}.json`, canonical(value)),
    );
  }
  const approvalRecord = {
    schema_version: 1,
    approval_digest: approvalDigest,
    input_digest: qualificationInputDigest(context.input),
    actions_run_id: output.actions_run_id,
    actor: actor.login,
    mode,
    approved_at: approvedAt,
  };
  const nextState: DemoState = {
    ...context.state,
    qualified: true,
    qualification_mode: mode,
  };
  files.push(makeFile(approvalPath, canonical(approvalRecord)));
  files.push(makeFile(".fullbeam/benchmark.lock.json", canonical(lock)));
  files.push(makeFile(".fullbeam/demo-state.json", canonical(nextState)));
  await new GitHubBootstrap(context.client).commitFiles({
    branch: context.head.branch,
    baseCommitSha: context.head.sha,
    message:
      mode === "HUMAN"
        ? "Approve calibrated Fullbeam seeded SMOKE benchmark"
        : "Record automated SILVER calibration for owned seeded SMOKE demo",
    files: gitCommitFiles(files),
  });
  await context.store.saveState("demo-state.json", nextState);
  await context.store.saveState(pendingPath, null);
}

export async function qualificationOnly(
  config: Config,
  options: { approveQualification?: string } = {},
): Promise<QualificationOutput> {
  config = { ...config, demoRepository: config.repository };
  const qualified = await prepareQualification(config);
  console.log(
    qualified.packages
      .map(
        (taskPackage) =>
          `${taskPackage.task.id}: ${taskPackage.controls.length} controls, ${taskPackage.task.pass_to_pass_test_ids.length} PASS_TO_PASS, ${taskPackage.task.fail_to_pass_test_ids.length} FAIL_TO_PASS`,
      )
      .join("\n"),
  );
  if (options.approveQualification === undefined) {
    console.log(
      `Qualification remains pending. Review the evidence, then run: npm run fullbeam -- qualify --approve ${qualified.approval_digest}`,
    );
    return qualified;
  }
  await approveQualification(config, qualified, options.approveQualification);
  return qualified;
}

export async function demo(
  config: Config,
  options: DemoOptions = {},
): Promise<void> {
  if (
    options.automated &&
    (options.approveSeed !== undefined ||
      options.approveQualification !== undefined)
  )
    throw new Error("Automated demo cannot also claim explicit human approval");
  const initial = github(config, config.demoRepository);
  const identity = await defaultHead(initial);
  const client = github(config, config.demoRepository, identity.id);
  const bootstrap = new GitHubBootstrap(client);
  const actor = await client.authenticatedActor();
  let state = await readRepoJson<DemoState>(
    client,
    ".fullbeam/demo-state.json",
    identity.sha,
  );
  if (
    state.repository_id !== identity.id ||
    state.repository !== config.demoRepository ||
    !identity.private
  )
    throw new Error("Demo state repository identity mismatch");
  if (!options.automated && state.qualification_mode === "AUTOMATED_DEMO")
    throw new Error(
      "This demo contains automated SILVER qualification. Continue in automated mode; it does not carry human GOLD approval.",
    );
  const runtime = await readRepoJson<RuntimeLock>(
    client,
    ".fullbeam/runtime.lock.json",
    identity.sha,
  );
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  const localState = await store.state<DemoState>("demo-state.json");
  if (
    !options.automated &&
    [
      state,
      ...(localState?.repository_id === state.repository_id
        ? [localState]
        : []),
    ].some((record) =>
      record.items.some((item) => item.review_mode === "AUTOMATED_DEMO"),
    )
  )
    throw new Error(
      "This demo uses automated seed preparation. Continue in automated mode; human review cannot be inferred.",
    );
  const grader = await graderBundle();
  const save = async () => {
    await store.saveState("demo-state.json", state);
    await commitJson(
      client,
      ".fullbeam/demo-state.json",
      state,
      "Record observed Fullbeam demo progress",
    );
  };

  for (let index = 0; index < seedTasks.length; index += 1) {
    const task = seedTasks[index]!;
    let item = state.items.find((candidate) => candidate.id === task.id);
    if (item?.merge_receipt) continue;
    if (!item) {
      const issue = await bootstrap.ensureIssue({
        marker: task.id,
        title: task.title,
        body: task.body,
      });
      const snapshot = await client.rest<{
        title: string;
        body: string;
        updated_at: string;
      }>("GET", `issues/${issue.number}`);
      item = {
        id: task.id,
        issue: issue.number,
        issue_snapshot: { ...snapshot, captured_at: new Date().toISOString() },
      };
      state.items.push(item);
      await save();
      await client.rest("POST", `issues/${issue.number}/labels`, {
        labels: [
          "fullbeam:seeded-demo",
          "fullbeam:eval-candidate",
          ...(task.risk === "CRITICAL" ? ["risk:critical"] : []),
        ],
      });
    }
    const localItem =
      localState?.repository_id === state.repository_id
        ? localState.items.find((candidate) => candidate.id === task.id)
        : undefined;
    if (
      !item.approved_by &&
      localItem?.approved_by &&
      sameSeedIdentity(item, localItem)
    ) {
      item.approved_by = localItem.approved_by;
      if (localItem.review_mode) item.review_mode = localItem.review_mode;
      if (localItem.review_evidence)
        item.review_evidence = localItem.review_evidence;
    }
    const branch = `fullbeam/seed/${task.id}`;
    if (!item.pr) {
      const head = await defaultHead(client);
      const expectedBase = await materializeFixture(index as RelayDeskStage);
      const baseTree = fromGitFiles(
        (
          await freezeSourceTree(client, head.sha, {
            allowPaths: APPLICATION_PATHS,
          })
        ).files,
      );
      assertFixtureMatches(baseTree, expectedBase, `${task.id} base`);
      const expectedReference = await materializeFixture(
        (index + 1) as RelayDeskStage,
      );
      let commitSha: string;
      try {
        commitSha = (
          await client.rest<{ object: { sha: string } }>(
            "GET",
            `git/ref/heads/${encodeURIComponent(branch)}`,
          )
        ).object.sha;
        const branchTree = fromGitFiles(
          (
            await freezeSourceTree(client, commitSha, {
              allowPaths: APPLICATION_PATHS,
            })
          ).files,
        );
        assertFixtureMatches(
          branchTree,
          expectedReference,
          `${task.id} reference branch`,
        );
        const commit = await client.rest<{ parents: Array<{ sha: string }> }>(
          "GET",
          `git/commits/${encodeURIComponent(commitSha)}`,
        );
        if (commit.parents.length !== 1 || !commit.parents[0])
          throw new Error(
            "Existing seed branch must contain one focused commit",
          );
        const [parentTree, fullBranchTree] = await Promise.all([
          freezeSourceTree(client, commit.parents[0].sha),
          freezeSourceTree(client, commitSha),
        ]);
        const expectedPaths = changedFixtureFiles(
          expectedBase,
          expectedReference,
        ).map((file) => file.path);
        if (
          !sameStrings(
            diffFrozenTrees(parentTree, fullBranchTree),
            expectedPaths,
          )
        )
          throw new Error(
            "Existing seed branch contains changes outside the intended source and public regression test",
          );
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404))
          throw error;
        commitSha = (
          await bootstrap.commitFiles({
            branch,
            baseCommitSha: head.sha,
            message: `Fix ${task.title}`,
            files: gitCommitFiles(
              changedFixtureFiles(expectedBase, expectedReference),
            ),
          })
        ).commitSha;
      }
      item.head = commitSha;
      item.branch = branch;
      await save();
      const pull = await bootstrap.ensurePullRequest({
        marker: task.id,
        title: task.title,
        body: `Closes #${item.issue}\n\nOwned SEEDED_DEMO reference fix. ${options.automated ? "Fullbeam will automatically squash-merge this exact fixture after remote checks pass. This is automated fixture preparation, not human code review." : "Fullbeam will run remote checks and ask the operator to review before squash merge."}`,
        head: branch,
        base: head.branch,
        expectedHeadSha: commitSha,
      });
      item.pr = pull.number;
      await save();
    }
    if (!item.head || !item.pr)
      throw new Error("Seed PR has no recorded head or pull request");
    const currentPull = await client.rest<PullState>("GET", `pulls/${item.pr}`);
    if (currentPull.head.sha !== item.head)
      throw new Error("Seed PR head changed after recording");
    if (currentPull.merged) {
      if (!currentPull.merge_commit_sha)
        throw new Error("Merged seed PR has no merge commit identity");
      const mergeCommit = await client.rest<{
        parents: Array<{ sha: string }>;
      }>(
        "GET",
        `git/commits/${encodeURIComponent(currentPull.merge_commit_sha)}`,
      );
      if (
        mergeCommit.parents.length !== 1 ||
        mergeCommit.parents[0]?.sha !== localItem?.base
      )
        throw new Error(
          "Persisted seed receipt does not match the squash merge parent",
        );
      Object.assign(item, recoverSeedMerge(item, localItem, currentPull));
      await save();
      continue;
    }
    if (!item.approved_by) {
      const pendingPath = `seed-reviews/${task.id}.json`;
      const pending = await store.state<StoredSeedReview>(pendingPath);
      let evidence: ArtifactRef;
      if (
        pending?.schema_version === 1 &&
        pending.task_id === task.id &&
        pending.head_sha === item.head
      ) {
        const result = await store.readJson<SeedCheckResult>(pending.evidence);
        assertPassingSeedCheck(result, task.id);
        evidence = pending.evidence;
      } else {
        const tree = await freezeSourceTree(client, item.head, {
          allowPaths: APPLICATION_PATHS,
        });
        const remote = new RemoteController(
          config,
          runtime,
          store,
          `seed-${task.id}-${item.head.slice(0, 12)}`,
        );
        await remote.initialize();
        try {
          const check = await remote.execute(
            `${remote.runId}-${Date.now()}`,
            fromGitFiles(tree.files),
            {
              role: "verification",
              taskId: task.id,
              timeoutSeconds: 120,
              buildCommand: ["sh", "-c", "npm run build && npm test"],
              ...grader,
            },
          );
          assertPassingSeedCheck(check.result, task.id);
          if (check.cleanup !== "CONFIRMED")
            throw new Error("Seed reference cleanup is not confirmed");
          evidence = await store.putJson(check.result);
          await store.saveState(pendingPath, {
            schema_version: 1,
            task_id: task.id,
            head_sha: item.head,
            evidence,
          } satisfies StoredSeedReview);
        } finally {
          await remote.close();
        }
      }
      console.log(
        `${options.automated ? "Automated fixture preparation" : "Review"}: https://github.com/${config.demoRepository}/pull/${item.pr}\nRemote check evidence SHA-256: ${evidence.sha256}`,
      );
      const reviewed = await reviewSeedCheck(
        item,
        evidence,
        await store.readJson<SeedCheckResult>(evidence),
        actor.login,
        options,
      );
      if (!reviewed) return;
      Object.assign(item, reviewed);
      await save();
      await store.saveState(pendingPath, null);
    }
    const receipt = await bootstrap.mergeApprovedSeedPull({
      pullNumber: item.pr,
      marker: task.id,
      expectedHeadSha: item.head,
      approvedBy: item.approved_by!,
      approved: true,
    });
    item.merge_receipt = {
      ...receipt,
      reviewMode: item.review_mode ?? "HUMAN",
    };
    item.base = receipt.baseCommitSha;
    item.reference = receipt.mergeCommitSha;
    await save();
  }

  if (!state.qualified) {
    const qualified = await prepareQualification(config, options);
    console.log(
      qualified.packages
        .map(
          (taskPackage) =>
            `${taskPackage.task.id}: ${taskPackage.controls.length} controls, ${taskPackage.task.pass_to_pass_test_ids.length} PASS_TO_PASS, ${taskPackage.task.fail_to_pass_test_ids.length} FAIL_TO_PASS`,
        )
        .join("\n"),
    );
    if (
      !options.automated &&
      !(await requestReview(
        "Approve the requirement-to-assertion mapping and observed calibration controls",
        qualified.approval_digest,
        options.approveQualification,
      ))
    )
      return;
    await approveQualification(
      config,
      qualified,
      qualified.approval_digest,
      options.automated ? "AUTOMATED_DEMO" : "HUMAN",
    );
    const head = await defaultHead(client);
    state = await readRepoJson<DemoState>(
      client,
      ".fullbeam/demo-state.json",
      head.sha,
    );
  }
  if (!state.candidate_pr) {
    const head = await defaultHead(client);
    const path = ".agents/skills/verify-change/SKILL.md";
    const source = await client.rest<{ content: string }>(
      "GET",
      `contents/${encodeURIComponent(path)}?ref=${head.sha}`,
    );
    const text = Buffer.from(
      source.content.replace(/\s/g, ""),
      "base64",
    ).toString();
    const branch = "fullbeam/harness-explicit-verification";
    let sha: string;
    try {
      sha = (
        await client.rest<{ object: { sha: string } }>(
          "GET",
          `git/ref/heads/${encodeURIComponent(branch)}`,
        )
      ).object.sha;
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404))
        throw error;
      sha = (
        await bootstrap.commitFiles({
          branch,
          baseCommitSha: head.sha,
          message:
            "Require explicit positive and negative verification evidence",
          files: [
            {
              path,
              content: `${text}\nBefore concluding, explicitly exercise one positive and one negative behavior relevant to the request. Distinguish observed results from unexecuted checks in the final response.\n`,
            },
          ],
        })
      ).commitSha;
    }
    const pull = await bootstrap.ensurePullRequest({
      marker: "harness-explicit-verification",
      title: "Evaluate explicit positive and negative verification workflow",
      body: "Harness-only policy experiment. The model, runtime, permissions and budgets are unchanged. This seeded SMOKE comparison does not predict production readiness.",
      head: branch,
      base: head.branch,
      expectedHeadSha: sha,
    });
    state.candidate_pr = pull.number;
    state.candidate_head = sha;
    await save();
  }
  const run = await dispatchAndWait(
    client,
    "compare",
    state.candidate_pr,
    options.previous,
  );
  state.last_run_id = run.id;
  await save();
  console.log(
    `Comparison ${run.conclusion}: ${run.url}\nPR: https://github.com/${config.demoRepository}/pull/${state.candidate_pr}`,
  );
  if (run.conclusion !== "success")
    throw new Error(
      "Demo workflow reported incomplete/failed execution; inspect retained evidence and cleanup",
    );
}

function applicationFiles(files: FileEntry[]): FileEntry[] {
  return files.filter((file) =>
    APPLICATION_PATHS.some(
      (path) =>
        file.path === path ||
        file.path.startsWith(`${path.replace(/\/$/, "")}/`),
    ),
  );
}

function sameSeedIdentity(left: SeedItem, right: SeedItem): boolean {
  return (
    left.id === right.id &&
    left.issue === right.issue &&
    left.pr === right.pr &&
    left.head === right.head
  );
}

export function assertPassingSeedCheck(
  result: SeedCheckResult,
  taskId: string,
): void {
  const expected = expectedCheckIds(taskId);
  const checks = result.checks ?? [];
  const ids = checks.map((check) => check.id);
  if (
    result.status !== "COMPLETED" ||
    result.integrityVerified !== true ||
    !Array.isArray(result.violations) ||
    result.violations.length > 0 ||
    !result.buildPassed ||
    !result.startupPassed ||
    checks.length !== expected.length ||
    new Set(ids).size !== expected.length ||
    expected.some(
      (id) =>
        !checks.some((check) => check.id === id && check.status === "PASS"),
    )
  )
    throw new Error(
      "Seed reference failed remote checks, integrity, or policy validation",
    );
}

function pendingQualificationPath(repositoryId: string): string {
  if (!/^[0-9]+$/.test(repositoryId))
    throw new Error("Invalid qualification repository identity");
  return `qualification/pending-${repositoryId}.json`;
}

async function qualificationContext(
  config: Config,
): Promise<QualificationContext> {
  const unscoped = github(config, config.demoRepository);
  const head = await defaultHead(unscoped);
  const client = github(config, config.demoRepository, head.id);
  const state = await readRepoJson<DemoState>(
    client,
    ".fullbeam/demo-state.json",
    head.sha,
  );
  const runtime = await readRepoJson<RuntimeLock>(
    client,
    ".fullbeam/runtime.lock.json",
    head.sha,
  );
  const policy = await readRepoJson<typeof DEFAULT_POLICY>(
    client,
    ".fullbeam/policy.json",
    head.sha,
  );
  if (
    state.repository_id !== head.id ||
    state.repository !== config.demoRepository
  )
    throw new Error("Qualification state repository identity mismatch");
  if (digest(policy) !== digest(DEFAULT_POLICY))
    throw new Error(
      "Unsupported policy revision; qualification inputs changed",
    );
  const grader = await graderBundle();
  const tasks = seedTasks.map((selected) => {
    const item = state.items.find((candidate) => candidate.id === selected.id);
    if (!item?.pr || !item.base || !item.reference || !item.merge_receipt)
      throw new Error(
        `Seed task ${selected.id} has no observed approved squash merge`,
      );
    return {
      id: selected.id,
      issue: item.issue,
      pull_request: item.pr,
      base_sha: item.base,
      reference_sha: item.reference,
      issue_snapshot_digest: digest(item.issue_snapshot),
      prompt_digest: digest(
        `${item.issue_snapshot.title}\n\n${item.issue_snapshot.body}`,
      ),
      merge_receipt_digest: digest(item.merge_receipt),
      definition_digest: digest(selected),
      risk: selected.risk,
      component: selected.component,
      expected_ids: expectedCheckIds(selected.id),
    };
  });
  const input: QualificationInput = {
    repository_id: String(head.id),
    source_commit: head.sha,
    runtime_digest: runtime.application_digest,
    verification_image: runtime.images.verification,
    policy_digest: digest(policy),
    verifier_digest: grader.verifierSha256,
    tasks,
  };
  return {
    client,
    head,
    state,
    runtime,
    input,
    store: new EvidenceStore(join(config.stateDir, "evidence")),
  };
}

function validateQualificationOutput(
  output: QualificationOutput,
  input: QualificationInput,
): void {
  validateApprovalDigest(output);
  if (
    output.repository_id !== input.repository_id ||
    output.source_commit !== input.source_commit ||
    output.runtime.application_digest !== input.runtime_digest ||
    output.runtime.images.verification !== input.verification_image ||
    output.policy_digest !== input.policy_digest
  )
    throw new Error(
      "Qualification output does not match the current frozen input identity",
    );
  for (const [id, value] of Object.entries(output.artifact_objects))
    if (digest(value) !== id)
      throw new Error("Qualification artifact content integrity mismatch");
  const packages = new Map(
    output.packages.map((taskPackage) => [taskPackage.task.id, taskPackage]),
  );
  if (
    packages.size !== input.tasks.length ||
    output.packages.length !== input.tasks.length
  )
    throw new Error("Qualification output has missing or duplicate tasks");
  for (const expected of input.tasks) {
    const taskPackage = packages.get(expected.id);
    if (!taskPackage || taskPackage.approval !== null)
      throw new Error(
        `Qualification output for ${expected.id} is missing or already approved`,
      );
    const task = validateRecord(taskPackage.task);
    const subject = taskPackage.subject;
    if (
      task.repository_id !== input.repository_id ||
      task.quality_tier !== "SILVER" ||
      task.qualified_by !== null ||
      task.issue_number !== expected.issue ||
      task.pull_request_number !== expected.pull_request ||
      task.base_sha !== expected.base_sha ||
      task.reference_sha !== expected.reference_sha ||
      task.issue_snapshot_sha256 !== expected.issue_snapshot_digest ||
      task.risk !== expected.risk ||
      task.component !== expected.component ||
      digest(taskPackage.issue_snapshot) !== expected.issue_snapshot_digest ||
      digest(taskPackage.prompt) !== expected.prompt_digest ||
      task.verifier_sha256 !== input.verifier_digest ||
      task.application_runtime_digest !== input.runtime_digest ||
      task.verifier_image_digest !== input.verification_image ||
      subject.repository_id !== input.repository_id ||
      subject.base_sha !== expected.base_sha ||
      subject.reference_sha !== expected.reference_sha ||
      subject.source_digest !== manifestDigest(taskPackage.source) ||
      subject.reference_digest !== manifestDigest(taskPackage.reference) ||
      subject.mutant_digest !== manifestDigest(taskPackage.mutant) ||
      task.source_bundle_sha256 !== subject.source_digest ||
      task.reference_patch_sha256 !==
        sourcePatchDigest(taskPackage.source, taskPackage.reference) ||
      subject.verifier_digest !== input.verifier_digest ||
      subject.runtime_digest !== input.runtime_digest ||
      subject.policy_digest !== input.policy_digest ||
      !sameStrings(subject.expected_ids, expected.expected_ids) ||
      !sameStrings(
        [...task.pass_to_pass_test_ids, ...task.fail_to_pass_test_ids],
        expected.expected_ids,
      )
    )
      throw new Error(
        `Qualification output for ${expected.id} does not match its frozen task input`,
      );
    if (
      taskPackage.controls.length !== 6 ||
      taskPackage.controls.some(
        (control) => control.subject_digest !== digest(subject),
      )
    )
      throw new Error(
        `Qualification output for ${expected.id} has invalid controls`,
      );
    const evaluation = evaluateCalibration(
      digest(subject),
      expected.expected_ids,
      taskPackage.controls,
    );
    if (
      !evaluation.qualified ||
      !sameStrings(evaluation.passToPass, task.pass_to_pass_test_ids) ||
      !sameStrings(evaluation.failToPass, task.fail_to_pass_test_ids)
    )
      throw new Error(
        `Qualification output for ${expected.id} does not reproduce its calibrated check groups`,
      );
    if (
      changedPaths(taskPackage.source, taskPackage.reference).some(
        (path) => !path.startsWith("src/"),
      ) ||
      changedPaths(taskPackage.source, taskPackage.mutant).some(
        (path) => !path.startsWith("src/"),
      )
    )
      throw new Error(
        `Qualification output for ${expected.id} contains a non-source reference or mutant overlay`,
      );
    for (const artifact of [
      ...task.calibration_artifacts,
      task.link_evidence_artifact,
    ])
      if (
        artifact.id !== artifact.sha256 ||
        !(artifact.id in output.artifact_objects)
      )
        throw new Error(
          `Qualification output for ${expected.id} is missing bound artifact evidence`,
        );
    task.calibration_artifacts.forEach((artifact, index) => {
      const raw = output.artifact_objects[artifact.id] as {
        status?: unknown;
        integrityVerified?: unknown;
        violations?: unknown;
        buildPassed?: unknown;
        startupPassed?: unknown;
        checks?: unknown;
      };
      const control = taskPackage.controls[index];
      if (
        !control ||
        !["COMPLETED", "FUNCTIONAL_FAIL"].includes(String(raw?.status)) ||
        raw?.integrityVerified !== true ||
        !Array.isArray(raw?.violations) ||
        raw.violations.length > 0 ||
        raw?.buildPassed !== control.buildPassed ||
        raw?.startupPassed !== control.startupPassed ||
        canonical(raw?.checks) !== canonical(control.checks)
      )
        throw new Error(
          `Qualification output for ${expected.id} has controls detached from valid execution evidence`,
        );
    });
  }
}

function validateApprovalDigest(output: QualificationOutput): void {
  const { approval_digest: approvalDigest, ...payload } = output;
  if (digest(payload) !== approvalDigest)
    throw new Error("Qualification approval payload integrity mismatch");
}

function sameStrings(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function changedPaths(base: FileEntry[], after: FileEntry[]): string[] {
  const before = new Map(
    base.map((file) => [file.path, `${file.mode}:${file.sha256}`]),
  );
  const next = new Map(
    after.map((file) => [file.path, `${file.mode}:${file.sha256}`]),
  );
  return [...new Set([...before.keys(), ...next.keys()])]
    .filter((path) => before.get(path) !== next.get(path))
    .sort();
}
