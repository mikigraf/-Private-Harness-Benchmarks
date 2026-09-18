import { GitHubApiError, type GitHubClient } from "./client.js";
import { diffFrozenTrees, freezeSourceTree } from "./freeze.js";
import type { GitFileMode, SeedLedger, SeedMergeReceipt } from "./types.js";

export const SEED_OWNER_PATH = ".fullbeam/seed-owner.json";
export const SEED_LEDGER_PATH = ".fullbeam/seed-ledger.json";

interface RepositoryResponse {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
}

interface IssueResponse {
  id: number;
  number: number;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}
interface PullResponse {
  id: number;
  number: number;
  body: string | null;
  html_url: string;
  state?: string;
  merged?: boolean;
  head: { sha: string; repo?: { id: number } | null };
  base?: { repo?: { id: number } | null };
  merge_commit_sha?: string | null;
}

function validateMarker(marker: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(marker))
    throw new Error("Seed marker must be a stable lowercase identifier");
}

function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe Git path: ${path}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export class GitHubBootstrap {
  constructor(private readonly client: GitHubClient) {}

  async ensurePrivateRepository(input: {
    ownerKind: "user" | "organization";
    description?: string;
    mode: "seed" | "normal";
    seedOwnerMarker?: string;
    allowExisting?: boolean;
  }): Promise<RepositoryResponse> {
    if (input.mode === "seed" && !input.seedOwnerMarker)
      throw new Error(
        "Seed repository creation requires a stable owner marker",
      );
    let existing: RepositoryResponse | undefined;
    try {
      existing = await this.client.accountRest<RepositoryResponse>(
        "GET",
        this.client.repoUrl().pathname,
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404)
        throw error;
    }
    if (existing) {
      this.assertRepositoryIdentity(existing);
      if (!existing.private)
        throw new Error(
          "Fullbeam bootstrap refuses an existing public repository",
        );
      if (input.mode === "normal" && input.allowExisting) return existing;
      if (input.mode !== "seed" || !input.seedOwnerMarker)
        throw new Error(
          "Existing repository requires explicit allowExisting in normal mode or a matching seed owner marker",
        );
      const marker = await this.readSeedOwner(existing.default_branch);
      if (marker !== input.seedOwnerMarker)
        throw new Error(
          "Existing repository is not owned by the requested Fullbeam seed marker",
        );
      return existing;
    }
    const path =
      input.ownerKind === "organization"
        ? `/orgs/${encodeURIComponent(this.client.repository.owner)}/repos`
        : "/user/repos";
    const created = await this.client.accountRest<RepositoryResponse>(
      "POST",
      path,
      {
        name: this.client.repository.repo,
        description: input.description,
        private: true,
        auto_init: true,
      },
    );
    this.assertRepositoryIdentity(created);
    if (!created.private)
      throw new Error("GitHub did not create a private repository");
    if (input.mode === "seed") {
      const branchRef = await this.client.rest<{ object: { sha: string } }>(
        "GET",
        `git/ref/${encodeURIComponent(`heads/${created.default_branch}`)}`,
      );
      await this.commitFiles({
        branch: created.default_branch,
        baseCommitSha: branchRef.object.sha,
        message: "chore: record Fullbeam seed ownership",
        files: [
          {
            path: SEED_OWNER_PATH,
            content: `${JSON.stringify({ version: 1, marker: input.seedOwnerMarker, repositoryId: created.id }, null, 2)}\n`,
          },
        ],
      });
    }
    return created;
  }

  async commitFiles(input: {
    branch: string;
    baseCommitSha: string;
    message: string;
    files: ReadonlyArray<{
      path: string;
      content: string | Uint8Array;
      mode?: GitFileMode;
    }>;
    deletePaths?: ReadonlyArray<string>;
  }): Promise<{ commitSha: string; treeSha: string; branch: string }> {
    if (
      !input.branch ||
      input.branch.startsWith("-") ||
      input.branch.includes("..") ||
      /[~^:?*[\\\s]/.test(input.branch)
    )
      throw new Error("Unsafe Git branch name");
    if (!input.message.trim()) throw new Error("Commit message is required");
    if (input.files.length === 0 && !input.deletePaths?.length)
      throw new Error("At least one file or deletion is required");
    const writtenPaths = new Set(input.files.map((file) => file.path));
    for (const path of input.deletePaths ?? []) {
      validatePath(path);
      if (writtenPaths.has(path))
        throw new Error(
          `Git path cannot be written and deleted in one commit: ${path}`,
        );
    }
    const base = await this.client.rest<{ tree: { sha: string } }>(
      "GET",
      `git/commits/${encodeURIComponent(input.baseCommitSha)}`,
    );
    const treeEntries: Array<{
      path: string;
      mode: GitFileMode;
      type: "blob";
      sha: string | null;
    }> = [];
    for (const file of input.files) {
      validatePath(file.path);
      const mode = file.mode ?? "100644";
      if (mode !== "100644" && mode !== "100755")
        throw new Error(`Unsupported Git file mode ${String(mode)}`);
      const content =
        typeof file.content === "string"
          ? Buffer.from(file.content, "utf8")
          : Buffer.from(file.content);
      const blob = await this.client.rest<{ sha: string }>(
        "POST",
        "git/blobs",
        { content: content.toString("base64"), encoding: "base64" },
      );
      treeEntries.push({ path: file.path, mode, type: "blob", sha: blob.sha });
    }
    for (const path of input.deletePaths ?? [])
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    const tree = await this.client.rest<{ sha: string }>("POST", "git/trees", {
      base_tree: base.tree.sha,
      tree: treeEntries,
    });
    const commit = await this.client.rest<{ sha: string }>(
      "POST",
      "git/commits",
      {
        message: input.message,
        tree: tree.sha,
        parents: [input.baseCommitSha],
      },
    );
    const encodedRef = encodeURIComponent(`heads/${input.branch}`);
    try {
      await this.client.rest("GET", `git/ref/${encodedRef}`);
      await this.client.rest("PATCH", `git/refs/${encodedRef}`, {
        sha: commit.sha,
        force: false,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404)
        throw error;
      await this.client.rest("POST", "git/refs", {
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      });
    }
    return { commitSha: commit.sha, treeSha: tree.sha, branch: input.branch };
  }

  async ensureIssue(input: {
    marker: string;
    title: string;
    body: string;
  }): Promise<IssueResponse> {
    validateMarker(input.marker);
    const marker = `<!-- fullbeam:seed:issue:${input.marker} -->`;
    const issues = await this.client.paginate<IssueResponse>("issues", {
      state: "all",
      per_page: 100,
    });
    const found = issues.filter(
      (issue) => !issue.pull_request && issue.body?.includes(marker),
    );
    if (found.length > 1)
      throw new Error(`Duplicate Fullbeam issue marker ${input.marker}`);
    if (found[0]) return found[0];
    return this.client.rest<IssueResponse>("POST", "issues", {
      title: input.title,
      body: `${input.body}\n\n${marker}`,
    });
  }

  async ensurePullRequest(input: {
    marker: string;
    title: string;
    body: string;
    head: string;
    base: string;
    expectedHeadSha: string;
  }): Promise<PullResponse> {
    validateMarker(input.marker);
    const marker = `<!-- fullbeam:seed:pull:${input.marker} -->`;
    const pulls = await this.client.paginate<PullResponse>("pulls", {
      state: "all",
      head: `${this.client.repository.owner}:${input.head}`,
      per_page: 100,
    });
    const found = pulls.filter((pull) => pull.body?.includes(marker));
    if (found.length > 1)
      throw new Error(`Duplicate Fullbeam pull marker ${input.marker}`);
    if (found[0]) {
      if (found[0].head.sha !== input.expectedHeadSha)
        throw new Error(
          "Existing seed pull request head does not match the expected commit",
        );
      return found[0];
    }
    const created = await this.client.rest<PullResponse>("POST", "pulls", {
      title: input.title,
      body: `${input.body}\n\n${marker}`,
      head: input.head,
      base: input.base,
    });
    if (created.head.sha !== input.expectedHeadSha)
      throw new Error(
        "Created seed pull request head does not match the expected commit",
      );
    return created;
  }

  async mergeApprovedSeedPull(input: {
    pullNumber: number;
    marker: string;
    expectedHeadSha: string;
    approvedBy: string;
    approved: true;
  }): Promise<
    SeedMergeReceipt & { baseCommitSha: string; changedPaths: string[] }
  > {
    validateMarker(input.marker);
    if (input.approved !== true || !input.approvedBy.trim())
      throw new Error("Explicit seed merge approval is required");
    const actor = await this.client.authenticatedActor();
    if (actor.login.toLowerCase() !== input.approvedBy.toLowerCase())
      throw new Error(
        "Seed merge approver does not match the authenticated GitHub actor",
      );
    const pull = await this.client.rest<PullResponse>(
      "GET",
      `pulls/${input.pullNumber}`,
    );
    const marker = `<!-- fullbeam:seed:pull:${input.marker} -->`;
    if (!pull.body?.includes(marker) || pull.head.sha !== input.expectedHeadSha)
      throw new Error("Seed pull marker or exact head does not match approval");
    if (
      !pull.head.repo ||
      !pull.base?.repo ||
      pull.head.repo.id !== pull.base.repo.id
    )
      throw new Error("Only same-repository seed pull requests can be merged");
    if (
      this.client.repository.repositoryId !== undefined &&
      pull.base.repo.id !== this.client.repository.repositoryId
    )
      throw new Error("Seed pull does not belong to the authorized repository");
    const merged = await this.client.rest<{
      merged: boolean;
      sha: string;
      message: string;
    }>("PUT", `pulls/${input.pullNumber}/merge`, {
      sha: input.expectedHeadSha,
      merge_method: "squash",
    });
    if (!merged.merged || !merged.sha)
      throw new Error(
        "GitHub did not squash-merge the approved seed pull request",
      );
    const refreshed = await this.client.rest<PullResponse>(
      "GET",
      `pulls/${input.pullNumber}`,
    );
    if (!refreshed.merged || refreshed.merge_commit_sha !== merged.sha)
      throw new Error(
        "Merged pull request did not resolve to the returned commit",
      );
    const commit = await this.client.rest<{ parents: Array<{ sha: string }> }>(
      "GET",
      `git/commits/${encodeURIComponent(merged.sha)}`,
    );
    if (commit.parents.length !== 1 || !commit.parents[0])
      throw new Error("Squash merge commit did not have one historical parent");
    const [base, accepted] = await Promise.all([
      freezeSourceTree(this.client, commit.parents[0].sha),
      freezeSourceTree(this.client, merged.sha),
    ]);
    return {
      pullNumber: input.pullNumber,
      marker: input.marker,
      headSha: input.expectedHeadSha,
      mergeCommitSha: merged.sha,
      mergeMethod: "squash",
      approvedBy: input.approvedBy,
      baseCommitSha: commit.parents[0].sha,
      changedPaths: diffFrozenTrees(base, accepted),
    };
  }

  async loadSeedLedger(ref: string): Promise<SeedLedger | undefined> {
    try {
      const response = await this.client.rest<{
        encoding: string;
        content: string;
      }>(
        "GET",
        `contents/${encodeURIComponent(SEED_LEDGER_PATH)}?ref=${encodeURIComponent(ref)}`,
      );
      if (response.encoding !== "base64")
        throw new Error("Unsupported seed ledger encoding");
      const ledger = JSON.parse(
        Buffer.from(response.content.replace(/\s/g, ""), "base64").toString(
          "utf8",
        ),
      ) as SeedLedger;
      if (
        ledger.version !== 1 ||
        ledger.repositoryId !== this.client.repository.repositoryId
      )
        throw new Error("Seed ledger belongs to a different repository");
      return ledger;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404)
        return undefined;
      throw error;
    }
  }

  async saveSeedLedger(input: {
    branch: string;
    baseCommitSha: string;
    ledger: SeedLedger;
  }): Promise<{ commitSha: string; treeSha: string; branch: string }> {
    if (
      this.client.repository.repositoryId === undefined ||
      input.ledger.repositoryId !== this.client.repository.repositoryId
    ) {
      throw new Error(
        "Seed ledger repository ID does not match the authorized repository",
      );
    }
    for (const [key, entry] of Object.entries(input.ledger.entries)) {
      validateMarker(key);
      if (entry.marker !== key)
        throw new Error(`Seed ledger marker mismatch for ${key}`);
    }
    return this.commitFiles({
      branch: input.branch,
      baseCommitSha: input.baseCommitSha,
      message: "chore: update Fullbeam seed ledger",
      files: [
        {
          path: SEED_LEDGER_PATH,
          content: `${JSON.stringify(canonicalize(input.ledger), null, 2)}\n`,
        },
      ],
    });
  }

  private async readSeedOwner(ref: string): Promise<string> {
    const response = await this.client.rest<{
      encoding: string;
      content: string;
    }>(
      "GET",
      `contents/${encodeURIComponent(SEED_OWNER_PATH)}?ref=${encodeURIComponent(ref)}`,
    );
    if (response.encoding !== "base64")
      throw new Error("Unsupported seed owner marker encoding");
    const value = JSON.parse(
      Buffer.from(response.content.replace(/\s/g, ""), "base64").toString(
        "utf8",
      ),
    ) as { marker?: unknown };
    if (typeof value.marker !== "string")
      throw new Error("Invalid seed owner marker");
    return value.marker;
  }

  private assertRepositoryIdentity(repository: RepositoryResponse): void {
    if (
      repository.owner.login.toLowerCase() !==
        this.client.repository.owner.toLowerCase() ||
      repository.full_name.toLowerCase() !==
        `${this.client.repository.owner}/${this.client.repository.repo}`.toLowerCase()
    ) {
      throw new Error(
        "GitHub repository identity does not match the explicitly authorized owner/name",
      );
    }
    if (
      this.client.repository.repositoryId !== undefined &&
      repository.id !== this.client.repository.repositoryId
    ) {
      throw new Error("GitHub repository numeric identity changed");
    }
  }
}
