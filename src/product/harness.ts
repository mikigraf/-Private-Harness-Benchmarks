import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../core/config.js";
import {
  makeFile,
  normalizePath,
  overlayFiles,
  validateBundle,
  type FileEntry,
} from "../core/integrity.js";
import {
  GitHubApiError,
  GitHubBootstrap,
  freezeSourceTree,
  diffFrozenTrees,
  type GitHubClient,
} from "../github/index.js";
import {
  classifyHarnessChange,
  validateHarnessConfiguration,
  type HarnessChangeClassification,
} from "../harness/resolve.js";
import { fromGitFiles, gitCommitFiles } from "./files.js";
import { defaultHead, github } from "./github-context.js";

const CONFIG_PATH = ".codex/config.toml";
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const NATIVE_KEYS = [
  "model",
  "model_reasoning_effort",
  "approval_policy",
  "sandbox_mode",
  "web_search",
];

export interface HarnessProposalOptions {
  name: string;
  model?: string;
  reasoningEffort?: string;
  overlayDir?: string;
}
export interface HarnessProposal {
  pr: number;
  url: string;
  head: string;
  branch: string;
  classification: Exclude<HarnessChangeClassification, "UNCHANGED" | "UNKNOWN">;
  changedPaths: string[];
}
interface Dependencies {
  client?: GitHubClient;
}
interface ProposalPull {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  title: string;
  body: string | null;
  user: { login: string };
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { sha: string; ref: string; repo: { id: number } | null };
}

function editablePath(path: string): boolean {
  return (
    path === "AGENTS.md" ||
    path === "skills.md" ||
    path === CONFIG_PATH ||
    /^\.agents\/skills\/[^/]+\/.+/.test(path)
  );
}
function clientFor(config: Config, dependencies: Dependencies): GitHubClient {
  const client = dependencies.client ?? github(config);
  if (
    `${client.repository.owner}/${client.repository.repo}`.toLowerCase() !==
    config.repository.toLowerCase()
  )
    throw new Error("Harness client is outside the configured repository");
  return client;
}
async function protectedHead(client: GitHubClient) {
  const head = await defaultHead(client);
  if (
    !head.private ||
    (client.repository.repositoryId !== undefined &&
      client.repository.repositoryId !== head.id)
  )
    throw new Error(
      "Harness authoring requires the authorized private repository",
    );
  const branch = await client.rest<{ protected: boolean }>(
    "GET",
    `branches/${encodeURIComponent(head.branch)}`,
  );
  if (!branch.protected)
    throw new Error(
      "Default branch must be protected before harness authoring",
    );
  return head;
}
function nativeSettings(files: FileEntry[]): Record<string, unknown> {
  const settings = validateHarnessConfiguration(files);
  if (
    Object.keys(settings).length !== NATIVE_KEYS.length ||
    NATIVE_KEYS.some((key) => !(key in settings))
  )
    throw new Error(
      "Harness configuration must contain exactly the five supported native settings",
    );
  if (
    typeof settings.model !== "string" ||
    !settings.model.trim() ||
    settings.model.length > 200 ||
    /\s/.test(settings.model)
  )
    throw new Error(
      "Model must be an explicit nonempty model identifier without whitespace",
    );
  if (
    typeof settings.model_reasoning_effort !== "string" ||
    !EFFORTS.includes(settings.model_reasoning_effort)
  )
    throw new Error("Unsupported native model_reasoning_effort");
  const paths = new Set(files.map((file) => file.path));
  for (const path of paths) {
    const skill = /^\.agents\/skills\/([^/]+)\//.exec(path)?.[1];
    if (skill && !paths.has(`.agents/skills/${skill}/SKILL.md`))
      throw new Error(
        `Skill resources require native metadata: .agents/skills/${skill}/SKILL.md`,
      );
  }
  return settings;
}
async function readOverlay(directory: string): Promise<FileEntry[]> {
  const root = resolve(directory),
    files: FileEntry[] = [];
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Overlay must be a real directory");
  let bytes = 0;
  async function visit(path: string, relative: string) {
    normalizePath(relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error(`Unsafe overlay entry: ${relative}`);
    if (info.isDirectory()) {
      if (
        ![".codex", ".agents", ".agents/skills"].includes(relative) &&
        !relative.startsWith(".agents/skills/")
      )
        throw new Error(
          `Overlay path is not editable harness content: ${relative}`,
        );
      for (const name of await readdir(path))
        await visit(join(path, name), `${relative}/${name}`);
    } else {
      if (!editablePath(relative))
        throw new Error(
          `Overlay path is not editable harness content: ${relative}`,
        );
      if (info.nlink !== 1)
        throw new Error(`Hardlinked overlay file: ${relative}`);
      bytes += info.size;
      if (bytes > 16 * 1024 * 1024 || files.length >= 2000)
        throw new Error("Harness overlay exceeds bundle limits");
      files.push(
        makeFile(
          relative,
          await readFile(path),
          info.mode & 0o111 ? 0o100755 : 0o100644,
        ),
      );
    }
  }
  for (const name of await readdir(root)) await visit(join(root, name), name);
  validateBundle(files);
  return files;
}

/** Export editable native files at an immutable commit; never execute repository content. */
export async function readHarnessSnapshot(
  config: Config,
  options: { ref?: string } = {},
  dependencies: Dependencies = {},
): Promise<{ head: string; files: FileEntry[] }> {
  const client = clientFor(config, dependencies),
    trusted = await protectedHead(client);
  const head = options.ref
    ? (
        await client.rest<{ sha: string }>(
          "GET",
          `commits/${encodeURIComponent(options.ref)}`,
        )
      ).sha
    : trusted.sha;
  if (!/^[a-f0-9]{40}$/.test(head))
    throw new Error("GitHub did not resolve an immutable harness commit");
  const tree = await freezeSourceTree(client, head, {
    allowPath: editablePath,
  });
  return { head, files: fromGitFiles(tree.files) };
}

/** Overlay native files first; explicit model/effort flags then override those values.
 * The proposal is a Git-versioned harness change, never a native client/runtime upgrade.
 */
export async function createHarnessProposal(
  config: Config,
  options: HarnessProposalOptions,
  dependencies: Dependencies = {},
): Promise<HarnessProposal> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.name))
    throw new Error(
      "Harness name must be a stable lowercase slug (1–63 characters)",
    );
  if (
    options.model === undefined &&
    options.reasoningEffort === undefined &&
    !options.overlayDir
  )
    throw new Error("Provide a model, reasoning effort, or harness overlay");
  if (
    options.model !== undefined &&
    (!options.model.trim() ||
      options.model.length > 200 ||
      /\s/.test(options.model))
  )
    throw new Error(
      "Model must be an explicit nonempty model identifier without whitespace",
    );
  if (
    options.reasoningEffort !== undefined &&
    !EFFORTS.includes(options.reasoningEffort)
  )
    throw new Error("Unsupported reasoning effort");
  const overlay = options.overlayDir
    ? await readOverlay(options.overlayDir)
    : [];
  const client = clientFor(config, dependencies),
    trusted = await protectedHead(client);
  const actor = await client.authenticatedActor();
  const branch = `fullbeam/harness/${options.name}`;
  const marker = `<!-- fullbeam:harness-proposal:v1 ${JSON.stringify({ repositoryId: trusted.id, name: options.name, base: trusted.sha, actor: actor.login })} -->`;
  const pullMarker = `<!-- fullbeam:seed:pull:harness-${options.name} -->`;
  const branchPath = `git/ref/heads/${encodeURIComponent(branch)}`;
  let existingHead: string | undefined;
  try {
    existingHead = (
      await client.rest<{ object: { sha: string } }>("GET", branchPath)
    ).object.sha;
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
  }
  const pulls = await client.paginate<ProposalPull>("pulls", {
    state: "all",
    head: `${client.repository.owner}:${branch}`,
    per_page: 100,
  });
  if (pulls.length > 1)
    throw new Error(
      "Ambiguous harness proposal branch: multiple pull requests",
    );
  const existing = pulls[0];
  if (
    existing &&
    (!existingHead ||
      existing.state !== "open" ||
      existing.merged ||
      existing.user.login.toLowerCase() !== actor.login.toLowerCase() ||
      !existing.body?.includes(marker) ||
      !existing.body.includes(pullMarker) ||
      existing.head.ref !== branch ||
      existing.head.sha !== existingHead ||
      existing.head.repo?.id !== trusted.id ||
      existing.base.ref !== trusted.branch ||
      existing.base.sha !== trusted.sha ||
      existing.base.repo?.id !== trusted.id)
  )
    throw new Error(
      "Existing proposal is not an owned open PR at the current protected default; use a new name",
    );
  if (existingHead && !existing) {
    // Recover a branch created by this helper if PR creation failed. Never adopt
    // another user's branch merely because its name matches our namespace.
    const commit = await client.rest<{
      author: { login: string } | null;
      commit: { message: string };
      parents: { sha: string }[];
    }>("GET", `commits/${existingHead}`);
    if (
      commit.author?.login.toLowerCase() !== actor.login.toLowerCase() ||
      !commit.commit.message.includes(marker) ||
      commit.parents.length !== 1 ||
      commit.parents[0]?.sha !== trusted.sha
    )
      throw new Error("Existing harness branch is not owned by this proposal");
  }
  const baselineTree = await freezeSourceTree(client, trusted.sha);
  const baseline = fromGitFiles(baselineTree.files);
  const currentTree = existingHead
    ? await freezeSourceTree(client, existingHead)
    : baselineTree;
  if (
    diffFrozenTrees(baselineTree, currentTree).some(
      (path) => !editablePath(path),
    )
  )
    throw new Error(
      "Existing proposal includes non-harness source/controller changes",
    );
  const current = fromGitFiles(currentTree.files);
  let candidate = overlayFiles(current, overlay);
  const configFile = candidate.find((file) => file.path === CONFIG_PATH);
  if (!configFile) throw new Error("Missing native .codex/config.toml");
  // Validate overlay keys and permissions before serializing explicit overrides.
  const settings = nativeSettings(candidate);
  if (options.model !== undefined || options.reasoningEffort !== undefined) {
    if (options.model !== undefined) settings.model = options.model;
    if (options.reasoningEffort !== undefined)
      settings.model_reasoning_effort = options.reasoningEffort;
    candidate = overlayFiles(candidate, [
      makeFile(
        CONFIG_PATH,
        NATIVE_KEYS.map(
          (key) => `${key} = ${JSON.stringify(settings[key])}`,
        ).join("\n") + "\n",
        configFile.mode,
      ),
    ]);
  }
  const baseSettings = nativeSettings(baseline),
    candidateSettings = nativeSettings(candidate);
  const harness = (files: FileEntry[]) => files.filter(editablePathEntry);
  const classification = classifyHarnessChange(
    { files: harness(baseline), settings: baseSettings },
    { files: harness(candidate), settings: candidateSettings },
  );
  if (classification === "UNCHANGED" || classification === "UNKNOWN")
    throw new Error("Proposal contains no effective model or harness change");
  const changed = (before: FileEntry[], after: FileEntry[]) => {
    const previous = new Map(before.map((f) => [f.path, f]));
    return after.filter(
      (file) =>
        previous.get(file.path)?.sha256 !== file.sha256 ||
        previous.get(file.path)?.mode !== file.mode,
    );
  };
  const candidatePaths = new Set(candidate.map((file) => file.path));
  const changedPaths = [
    ...changed(baseline, candidate).map((file) => file.path),
    ...baseline
      .filter((file) => !candidatePaths.has(file.path))
      .map((file) => file.path),
  ].sort();
  const writes = changed(current, candidate);
  if (changedPaths.some((path) => !editablePath(path)))
    throw new Error("Proposal changes non-harness content");
  const observedDefault = await client.rest<{ object: { sha: string } }>(
    "GET",
    `git/ref/heads/${encodeURIComponent(trusted.branch)}`,
  );
  if (observedDefault.object.sha !== trusted.sha)
    throw new Error("Protected default moved while preparing proposal; retry");
  if (existingHead) {
    const fresh = await client.rest<{ object: { sha: string } }>(
      "GET",
      branchPath,
    );
    if (fresh.object.sha !== existingHead)
      throw new Error("Proposal head moved while preparing changes; retry");
  }
  const bootstrap = new GitHubBootstrap(client);
  const head = writes.length
    ? (
        await bootstrap.commitFiles({
          branch,
          baseCommitSha: existingHead ?? trusted.sha,
          message: `Propose harness ${options.name}\n\n${marker}`,
          files: gitCommitFiles(writes),
        })
      ).commitSha
    : existingHead!;
  const title = `Evaluate harness ${options.name}`;
  const body = [
    `Change classification: **${classification}**.`,
    `Baseline: \`${trusted.sha}\`. Candidate: \`${head}\`.`,
    `Model: \`${String(baseSettings.model)}\` → \`${String(candidateSettings.model)}\`; reasoning: \`${String(baseSettings.model_reasoning_effort)}\` → \`${String(candidateSettings.model_reasoning_effort)}\`.`,
    "The native client, runtime, permissions, controller and application source are unchanged. Review these Git-versioned native files before evaluating the exact head.",
    classification === "BUNDLE"
      ? "Model settings and harness content changed together; results cannot isolate either change's effect."
      : "",
    "Changed paths:\n" + changedPaths.map((path) => `- \`${path}\``).join("\n"),
    marker,
  ]
    .filter(Boolean)
    .join("\n\n");
  const pull = await bootstrap.ensurePullRequest({
    marker: `harness-${options.name}`,
    title,
    body,
    head: branch,
    base: trusted.branch,
    expectedHeadSha: head,
  });
  if (
    existing &&
    (existing.title !== title || existing.body !== `${body}\n\n${pullMarker}`)
  )
    await client.rest("PATCH", `pulls/${pull.number}`, {
      title,
      body: `${body}\n\n${pullMarker}`,
    });
  const verified = await client.rest<ProposalPull>(
    "GET",
    `pulls/${pull.number}`,
  );
  if (
    verified.head.sha !== head ||
    verified.head.ref !== branch ||
    verified.head.repo?.id !== trusted.id ||
    verified.base.repo?.id !== trusted.id ||
    verified.base.ref !== trusted.branch ||
    verified.base.sha !== trusted.sha ||
    verified.state !== "open" ||
    verified.merged ||
    verified.user.login.toLowerCase() !== actor.login.toLowerCase() ||
    !verified.body?.includes(marker) ||
    !verified.body.includes(pullMarker)
  )
    throw new Error(
      "GitHub proposal identity/head did not match the prepared change",
    );
  return {
    pr: pull.number,
    url: pull.html_url,
    head,
    branch,
    classification,
    changedPaths,
  };
}
function editablePathEntry(file: FileEntry): boolean {
  return editablePath(file.path);
}
