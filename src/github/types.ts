export interface GitHubRepositoryIdentity {
  owner: string;
  repo: string;
  repositoryId?: number;
  apiBaseUrl?: string;
  graphqlUrl?: string;
}

export interface GitHubClientOptions {
  token: string;
  repository: GitHubRepositoryIdentity;
  apiVersion?: string;
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export type GitFileMode = "100644" | "100755";

export interface SourceFileManifestEntry {
  path: string;
  base64: string;
  size: number;
  gitBlobSha: string;
  sha256: string;
  mode: GitFileMode;
}

export interface FrozenSourceTree {
  commitSha: string;
  treeSha: string;
  files: SourceFileManifestEntry[];
}

export interface SeedMergeReceipt {
  pullNumber: number;
  marker: string;
  headSha: string;
  mergeCommitSha: string;
  mergeMethod: "squash";
  approvedBy: string;
}

export interface ImmutableCheckpointArtifact {
  id: string;
  name: string;
  sha256: string;
  immutable: true;
  transportUrl?: string;
}

/**
 * GitHub exposes run-artifact download/list APIs, but artifact upload is owned
 * by the Actions runtime. The controller supplies this implementation (for
 * example, a pinned upload-artifact action wrapper) and receives a stable
 * digest-bearing receipt.
 */
export interface ImmutableCheckpointArtifactWriter {
  writeCheckpoint(input: {
    name: string;
    files: ReadonlyArray<{ path: string; bytes: Uint8Array; sha256: string }>;
  }): Promise<ImmutableCheckpointArtifact>;
}

export interface SeedLedgerEntry {
  marker: string;
  issueNumber?: number;
  pullNumber?: number;
  branch?: string;
  headSha?: string;
  merge?: SeedMergeReceipt;
}

export interface SeedLedger {
  version: 1;
  repositoryId: number;
  entries: Record<string, SeedLedgerEntry>;
}
