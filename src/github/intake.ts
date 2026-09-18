import { createHash } from "node:crypto";
import type { GitHubClient } from "./client.js";
import { diffFrozenTrees, freezeSourceTree } from "./freeze.js";
import type { FrozenSourceTree, SeedMergeReceipt } from "./types.js";

const PAIR_QUERY = `
query FullbeamPair($owner: String!, $repo: String!, $issue: Int!, $pull: Int!) {
  repository(owner: $owner, name: $repo) {
    id
    nameWithOwner
    issue(number: $issue) {
      id number url title body createdAt updatedAt author { login }
    }
    pullRequest(number: $pull) {
      id number url title body merged mergedAt baseRefOid headRefOid
      author { login }
      mergedBy { login }
      mergeCommit { oid }
      closingIssuesReferences(first: 10) { nodes { id number url } pageInfo { hasNextPage } }
    }
  }
}`;

interface PairQueryResponse {
  repository: {
    id: string;
    nameWithOwner: string;
    issue: null | {
      id: string;
      number: number;
      url: string;
      title: string;
      body: string | null;
      createdAt: string;
      updatedAt: string;
      author: null | { login: string };
    };
    pullRequest: null | {
      id: string;
      number: number;
      url: string;
      title: string;
      body: string | null;
      merged: boolean;
      mergedAt: string | null;
      baseRefOid: string;
      headRefOid: string;
      author: null | { login: string };
      mergedBy: null | { login: string };
      mergeCommit: null | { oid: string };
      closingIssuesReferences: {
        nodes: Array<{ id: string; number: number; url: string }>;
        pageInfo?: { hasNextPage: boolean };
      };
    };
  } | null;
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string; url: string }>;
}

export class UnsupportedHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedHistoryError";
  }
}

export interface ImportedPairSnapshot {
  repository: { id: number | undefined; fullName: string };
  issue: {
    number: number;
    nodeId: string;
    url: string;
    title: string;
    body: string;
    author: string | null;
    createdAt: string;
    updatedAt: string;
    snapshotSha256: string;
  };
  pullRequest: {
    number: number;
    nodeId: string;
    url: string;
    title: string;
    body: string;
    author: string | null;
    mergedBy: string;
    mergedAt: string;
    headCommitSha: string;
  };
  linkage: { kind: "GITHUB_CLOSING_RELATION"; verified: true };
  evidence: {
    issue: Record<string, unknown>;
    pullRequest: Record<string, unknown>;
    commits: Array<Record<string, unknown>>;
    files: Array<Record<string, unknown>>;
    reviews: Array<Record<string, unknown>>;
    checkRuns: Array<Record<string, unknown>>;
  };
  history: {
    strategy: "SUPPORTED_SEED_SQUASH";
    baseCommitSha: string;
    acceptedCommitSha: string;
    changedPaths: string[];
    baseSource: FrozenSourceTree;
    acceptedSource: FrozenSourceTree;
  };
  observedAt: string;
}

export class GitHubIntake {
  constructor(private readonly client: GitHubClient) {}

  async snapshotPair(input: {
    issueNumber: number;
    pullNumber: number;
    seedMergeReceipt?: SeedMergeReceipt;
    observedAt?: string;
    maxSourceBytes?: number;
  }): Promise<ImportedPairSnapshot> {
    if (
      !Number.isSafeInteger(input.issueNumber) ||
      input.issueNumber <= 0 ||
      !Number.isSafeInteger(input.pullNumber) ||
      input.pullNumber <= 0
    ) {
      throw new Error(
        "Issue and pull request numbers must be positive integers",
      );
    }
    const data = await this.client.graphql<PairQueryResponse>(PAIR_QUERY, {
      owner: this.client.repository.owner,
      repo: this.client.repository.repo,
      issue: input.issueNumber,
      pull: input.pullNumber,
    });
    const repository = data.repository;
    if (
      !repository ||
      repository.nameWithOwner.toLowerCase() !==
        `${this.client.repository.owner}/${this.client.repository.repo}`.toLowerCase()
    ) {
      throw new Error("GitHub returned a different repository identity");
    }
    const issue = repository.issue;
    const pull = repository.pullRequest;
    if (!issue || !pull)
      throw new Error(
        "Issue or pull request does not exist in the authorized repository",
      );
    const closing = pull.closingIssuesReferences.nodes;
    if (
      pull.closingIssuesReferences.pageInfo?.hasNextPage ||
      closing.length !== 1 ||
      closing[0]?.number !== issue.number ||
      closing[0].id !== issue.id
    ) {
      throw new Error(
        "Pull request does not have one unambiguous GitHub closing-issue relation to the requested issue",
      );
    }
    if (!pull.merged || !pull.mergedAt || !pull.mergedBy || !pull.mergeCommit) {
      throw new UnsupportedHistoryError(
        "Pull request is not a completed merge with an available merge commit",
      );
    }
    this.assertSeedSquashReceipt(
      input.seedMergeReceipt,
      pull.number,
      pull.headRefOid,
      pull.mergeCommit.oid,
      pull.mergedBy.login,
    );
    const commit = await this.client.rest<GitCommitResponse>(
      "GET",
      `git/commits/${encodeURIComponent(pull.mergeCommit.oid)}`,
    );
    if (commit.parents.length !== 1 || !commit.parents[0]) {
      throw new UnsupportedHistoryError(
        "Supported seed squash commit must have exactly one Git parent",
      );
    }
    const historicalBase = commit.parents[0].sha;
    const [
      baseSource,
      acceptedSource,
      rawIssue,
      rawPull,
      commits,
      files,
      reviews,
      checks,
    ] = await Promise.all([
      freezeSourceTree(this.client, historicalBase, {
        maxBytes: input.maxSourceBytes,
      }),
      freezeSourceTree(this.client, pull.mergeCommit.oid, {
        maxBytes: input.maxSourceBytes,
      }),
      this.client.rest<Record<string, unknown>>(
        "GET",
        `issues/${input.issueNumber}`,
      ),
      this.client.rest<Record<string, unknown>>(
        "GET",
        `pulls/${input.pullNumber}`,
      ),
      this.client.paginate<Record<string, unknown>>(
        `pulls/${input.pullNumber}/commits`,
        { per_page: 100 },
      ),
      this.client.paginate<Record<string, unknown>>(
        `pulls/${input.pullNumber}/files`,
        { per_page: 100 },
      ),
      this.client.paginate<Record<string, unknown>>(
        `pulls/${input.pullNumber}/reviews`,
        { per_page: 100 },
      ),
      this.client.rest<{ check_runs: Array<Record<string, unknown>> }>(
        "GET",
        `commits/${encodeURIComponent(pull.headRefOid)}/check-runs?per_page=100`,
      ),
    ]);
    const body = issue.body ?? "";
    return {
      repository: {
        id: this.client.repository.repositoryId,
        fullName: repository.nameWithOwner,
      },
      issue: {
        number: issue.number,
        nodeId: issue.id,
        url: issue.url,
        title: issue.title,
        body,
        author: issue.author?.login ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        snapshotSha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
      pullRequest: {
        number: pull.number,
        nodeId: pull.id,
        url: pull.url,
        title: pull.title,
        body: pull.body ?? "",
        author: pull.author?.login ?? null,
        mergedBy: pull.mergedBy.login,
        mergedAt: pull.mergedAt,
        headCommitSha: pull.headRefOid,
      },
      linkage: { kind: "GITHUB_CLOSING_RELATION", verified: true },
      evidence: {
        issue: rawIssue,
        pullRequest: rawPull,
        commits,
        files,
        reviews,
        checkRuns: checks.check_runs,
      },
      history: {
        strategy: "SUPPORTED_SEED_SQUASH",
        baseCommitSha: historicalBase,
        acceptedCommitSha: pull.mergeCommit.oid,
        changedPaths: diffFrozenTrees(baseSource, acceptedSource),
        baseSource,
        acceptedSource,
      },
      observedAt: input.observedAt ?? new Date().toISOString(),
    };
  }

  private assertSeedSquashReceipt(
    receipt: SeedMergeReceipt | undefined,
    pullNumber: number,
    headSha: string,
    mergeCommitSha: string,
    mergedBy: string,
  ): asserts receipt is SeedMergeReceipt {
    if (!receipt || receipt.mergeMethod !== "squash") {
      throw new UnsupportedHistoryError(
        "A Fullbeam-owned squash merge receipt is required; one-parent history alone is insufficient",
      );
    }
    if (
      receipt.pullNumber !== pullNumber ||
      receipt.headSha !== headSha ||
      receipt.mergeCommitSha !== mergeCommitSha ||
      receipt.approvedBy !== mergedBy
    ) {
      throw new UnsupportedHistoryError(
        "Seed squash receipt does not match GitHub merge provenance",
      );
    }
  }
}
