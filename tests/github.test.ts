import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  FULLBEAM_COMMENT_MARKER,
  GitHubActions,
  GitHubApiError,
  GitHubBootstrap,
  GitHubClient,
  GitHubIntake,
  GitHubPublisher,
  freezeSourceTree,
  type GitHubRepositoryIdentity,
  type SeedMergeReceipt,
} from "../src/github/index.js";

type RequestRecord = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

type StubReply = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

const servers: Array<{ close(): Promise<void> }> = [];

async function stubGitHub(
  handler: (request: RequestRecord) => StubReply | Promise<StubReply>,
): Promise<{ baseUrl: string; requests: RequestRecord[] }> {
  const requests: RequestRecord[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const record: RequestRecord = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(record);
      const reply = await handler(record);
      response.statusCode = reply.status ?? 200;
      for (const [name, value] of Object.entries(reply.headers ?? {}))
        response.setHeader(name, value);
      if (reply.body === undefined) return response.end();
      if (reply.body instanceof Uint8Array) return response.end(reply.body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply.body));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("stub server did not bind");
  const closable = {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  servers.push(closable);
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function identity(baseUrl: string): GitHubRepositoryIdentity {
  return {
    owner: "fullbeam-labs",
    repo: "relaydesk",
    repositoryId: 77,
    apiBaseUrl: baseUrl,
    graphqlUrl: `${baseUrl}/graphql`,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("GitHubClient", () => {
  it("paginates only inside its authorized repository and redacts API failures", async () => {
    const secret = "ghs_super-secret-token";
    const stub = await stubGitHub((request) => {
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/issues?per_page=100"
      ) {
        return {
          headers: {
            link: `<${stub.baseUrl}/repos/fullbeam-labs/relaydesk/issues?per_page=100&page=2>; rel=\"next\"`,
          },
          body: [{ id: 1 }],
        };
      }
      if (request.path.endsWith("page=2")) return { body: [{ id: 2 }] };
      return {
        status: 401,
        body: { message: `bad credential ${secret}`, token: secret },
      };
    });
    const client = new GitHubClient({
      token: secret,
      repository: identity(stub.baseUrl),
    });

    await expect(
      client.paginate<{ id: number }>("issues", { per_page: 100 }),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => client.repoUrl("../octocat/other")).toThrow(
      /outside the authorized repository/i,
    );
    await expect(client.rest("GET", "missing")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("bad credential");
        return true;
      },
    );
    expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${secret}`);
  });

  it("aborts a GitHub request at the configured bounded timeout", async () => {
    const stub = await stubGitHub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { body: { late: true } };
    });
    const client = new GitHubClient({
      token: "token",
      repository: identity(stub.baseUrl),
      requestTimeoutMs: 10,
    });

    await expect(client.rest("GET", "slow")).rejects.toThrow(
      /timed out after 10ms/i,
    );
  });
});

describe("freezeSourceTree", () => {
  it("materializes exact blob bytes with mode, size, Git SHA and SHA-256", async () => {
    const raw = Buffer.from("export const value = 1;\n");
    const gitSha = createHash("sha1")
      .update(Buffer.from(`blob ${raw.length}\0`))
      .update(raw)
      .digest("hex");
    const stub = await stubGitHub((request) => {
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/git/trees/base123?recursive=1"
      ) {
        return {
          body: {
            sha: "tree123",
            truncated: false,
            tree: [
              {
                path: "src/value.ts",
                mode: "100755",
                type: "blob",
                sha: gitSha,
                size: raw.length,
              },
            ],
          },
        };
      }
      if (
        request.path === `/repos/fullbeam-labs/relaydesk/git/blobs/${gitSha}`
      ) {
        return {
          body: {
            sha: gitSha,
            encoding: "base64",
            content: raw.toString("base64"),
            size: raw.length,
          },
        };
      }
      return { status: 404, body: { message: "not found" } };
    });
    const client = new GitHubClient({
      token: "token",
      repository: identity(stub.baseUrl),
    });

    const frozen = await freezeSourceTree(client, "base123");

    expect(frozen).toEqual({
      commitSha: "base123",
      treeSha: "tree123",
      files: [
        {
          path: "src/value.ts",
          base64: raw.toString("base64"),
          size: raw.length,
          gitBlobSha: gitSha,
          sha256: createHash("sha256").update(raw).digest("hex"),
          mode: "100755",
        },
      ],
    });
  });
});

describe("GitHubIntake", () => {
  it("uses GraphQL closingIssuesReferences and the merge commit parent as historical base", async () => {
    const stub = await stubGitHub((request) => {
      if (request.path === "/graphql")
        return {
          body: {
            data: {
              repository: {
                id: "R_77",
                nameWithOwner: "fullbeam-labs/relaydesk",
                issue: {
                  id: "I_12",
                  number: 12,
                  url: "https://github.test/issues/12",
                  title: "fix isolation",
                  body: "original issue",
                  author: { login: "reporter" },
                  createdAt: "2025-01-01T00:00:00Z",
                  updatedAt: "2025-01-01T00:00:00Z",
                },
                pullRequest: {
                  id: "P_34",
                  number: 34,
                  url: "https://github.test/pull/34",
                  title: "fix",
                  body: "seed",
                  author: { login: "author" },
                  merged: true,
                  mergedAt: "2025-01-03T00:00:00Z",
                  mergedBy: { login: "maintainer" },
                  baseRefOid: "moving-current-base",
                  headRefOid: "head34",
                  mergeCommit: { oid: "gold34" },
                  closingIssuesReferences: {
                    nodes: [
                      {
                        id: "I_12",
                        number: 12,
                        url: "https://github.test/issues/12",
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      if (request.path === "/repos/fullbeam-labs/relaydesk/issues/12")
        return {
          body: {
            id: 120,
            node_id: "I_12",
            number: 12,
            title: "fix isolation",
            body: "original issue",
            html_url: "https://github.test/issues/12",
          },
        };
      if (request.path === "/repos/fullbeam-labs/relaydesk/pulls/34")
        return {
          body: {
            id: 340,
            node_id: "P_34",
            number: 34,
            merged: true,
            merge_commit_sha: "gold34",
            head: { sha: "head34" },
          },
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/pulls/34/commits?per_page=100"
      )
        return { body: [{ sha: "head34" }] };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/pulls/34/files?per_page=100"
      )
        return {
          body: [{ filename: "app.ts", status: "modified", sha: "after" }],
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/pulls/34/reviews?per_page=100"
      )
        return {
          body: [{ id: 7, state: "APPROVED", user: { login: "maintainer" } }],
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/commits/head34/check-runs?per_page=100"
      )
        return {
          body: {
            total_count: 1,
            check_runs: [{ id: 8, name: "test", conclusion: "success" }],
          },
        };
      if (request.path === "/repos/fullbeam-labs/relaydesk/git/commits/gold34")
        return {
          body: {
            sha: "gold34",
            tree: { sha: "gold-tree" },
            parents: [{ sha: "historical-base", url: "x" }],
          },
        };
      const before = createHash("sha1")
        .update(Buffer.from("blob 1\0a"))
        .digest("hex");
      const after = createHash("sha1")
        .update(Buffer.from("blob 1\0b"))
        .digest("hex");
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/git/trees/historical-base?recursive=1"
      )
        return {
          body: {
            sha: "base-tree",
            truncated: false,
            tree: [
              {
                path: "app.ts",
                mode: "100644",
                type: "blob",
                sha: before,
                size: 1,
              },
            ],
          },
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/git/trees/gold34?recursive=1"
      )
        return {
          body: {
            sha: "gold-tree",
            truncated: false,
            tree: [
              {
                path: "app.ts",
                mode: "100644",
                type: "blob",
                sha: after,
                size: 1,
              },
            ],
          },
        };
      if (request.path.endsWith(`/git/blobs/${before}`))
        return {
          body: { sha: before, encoding: "base64", content: "YQ==", size: 1 },
        };
      if (request.path.endsWith(`/git/blobs/${after}`))
        return {
          body: { sha: after, encoding: "base64", content: "Yg==", size: 1 },
        };
      return { status: 404, body: { message: "not found" } };
    });
    const receipt: SeedMergeReceipt = {
      pullNumber: 34,
      marker: "task-isolation",
      headSha: "head34",
      mergeCommitSha: "gold34",
      mergeMethod: "squash",
      approvedBy: "maintainer",
    };
    const intake = new GitHubIntake(
      new GitHubClient({ token: "token", repository: identity(stub.baseUrl) }),
    );

    const snapshot = await intake.snapshotPair({
      issueNumber: 12,
      pullNumber: 34,
      seedMergeReceipt: receipt,
    });

    expect(snapshot.linkage).toEqual({
      kind: "GITHUB_CLOSING_RELATION",
      verified: true,
    });
    expect(snapshot.history.baseCommitSha).toBe("historical-base");
    expect(snapshot.history.acceptedCommitSha).toBe("gold34");
    expect(snapshot.history.changedPaths).toEqual(["app.ts"]);
    expect(snapshot.evidence.files).toEqual([
      { filename: "app.ts", status: "modified", sha: "after" },
    ]);
    expect(snapshot.evidence.reviews).toEqual([
      { id: 7, state: "APPROVED", user: { login: "maintainer" } },
    ]);
    expect(snapshot.history.baseCommitSha).not.toBe("moving-current-base");
    expect(snapshot.issue.snapshotSha256).toBe(
      createHash("sha256").update("original issue").digest("hex"),
    );
  });
});

describe("GitHubBootstrap", () => {
  it("creates a private seed repository and records its ownership marker", async () => {
    const stub = await stubGitHub((request) => {
      if (
        request.path === "/repos/fullbeam-labs/relaydesk" &&
        request.method === "GET"
      )
        return { status: 404, body: { message: "missing" } };
      if (request.path === "/user/repos" && request.method === "POST")
        return {
          body: {
            id: 77,
            full_name: "fullbeam-labs/relaydesk",
            private: true,
            default_branch: "main",
            owner: { login: "fullbeam-labs" },
          },
        };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/git/ref/heads%2Fmain"
      )
        return { body: { object: { sha: "initial" } } };
      if (request.path === "/repos/fullbeam-labs/relaydesk/git/commits/initial")
        return {
          body: { sha: "initial", tree: { sha: "initial-tree" }, parents: [] },
        };
      if (request.path.endsWith("/git/blobs") && request.method === "POST")
        return { body: { sha: "owner-blob" } };
      if (request.path.endsWith("/git/trees") && request.method === "POST")
        return { body: { sha: "owner-tree" } };
      if (request.path.endsWith("/git/commits") && request.method === "POST")
        return { body: { sha: "owner-commit" } };
      if (
        request.path ===
          "/repos/fullbeam-labs/relaydesk/git/refs/heads%2Fmain" &&
        request.method === "PATCH"
      )
        return { body: {} };
      return { status: 404, body: { message: "not found" } };
    });
    const bootstrap = new GitHubBootstrap(
      new GitHubClient({
        token: "bootstrap-token",
        repository: identity(stub.baseUrl),
      }),
    );

    await bootstrap.ensurePrivateRepository({
      ownerKind: "user",
      mode: "seed",
      seedOwnerMarker: "owner-marker",
    });

    const blobWrite = stub.requests.find(
      (request) =>
        request.path.endsWith("/git/blobs") && request.method === "POST",
    );
    const encoded = (blobWrite?.body as { content: string }).content;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(
      '"marker": "owner-marker"',
    );
  });

  it("commits files through Git objects and resumes issue and PR creation by stable markers", async () => {
    const marker = "tenant-isolation";
    const stub = await stubGitHub((request) => {
      if (request.path === "/repos/fullbeam-labs/relaydesk/git/commits/base")
        return {
          body: { sha: "base", tree: { sha: "old-tree" }, parents: [] },
        };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/git/blobs" &&
        request.method === "POST"
      )
        return { body: { sha: "new-blob" } };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/git/trees" &&
        request.method === "POST"
      )
        return { body: { sha: "new-tree" } };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/git/commits" &&
        request.method === "POST"
      )
        return { body: { sha: "new-commit" } };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/git/ref/heads%2Fseed%2Ftenant-isolation"
      )
        return { status: 404, body: { message: "missing" } };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/git/refs" &&
        request.method === "POST"
      )
        return {
          body: {
            ref: "refs/heads/seed/tenant-isolation",
            object: { sha: "new-commit" },
          },
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/issues?state=all&per_page=100"
      )
        return {
          body: [
            {
              id: 9,
              number: 12,
              body: `existing\n<!-- fullbeam:seed:issue:${marker} -->`,
              html_url: "https://github.test/issues/12",
            },
          ],
        };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/pulls?state=all&head=fullbeam-labs%3Aseed%2Ftenant-isolation&per_page=100"
      )
        return {
          body: [
            {
              id: 10,
              number: 34,
              body: `<!-- fullbeam:seed:pull:${marker} -->`,
              head: { sha: "new-commit" },
              html_url: "https://github.test/pull/34",
            },
          ],
        };
      return { status: 404, body: { message: "not found" } };
    });
    const bootstrap = new GitHubBootstrap(
      new GitHubClient({
        token: "bootstrap-token",
        repository: identity(stub.baseUrl),
      }),
    );

    const commit = await bootstrap.commitFiles({
      branch: "seed/tenant-isolation",
      baseCommitSha: "base",
      message: "seed: fix tenant isolation",
      files: [{ path: "src/app.ts", content: "fixed\n", mode: "100644" }],
      deletePaths: ["src/removed.ts"],
    });
    const issue = await bootstrap.ensureIssue({
      marker,
      title: "isolate tenants",
      body: "requirement",
    });
    const pull = await bootstrap.ensurePullRequest({
      marker,
      title: "fix isolation",
      body: "Closes #12",
      head: "seed/tenant-isolation",
      base: "main",
      expectedHeadSha: "new-commit",
    });

    expect(commit.commitSha).toBe("new-commit");
    expect(issue.number).toBe(12);
    expect(pull.number).toBe(34);
    expect(
      stub.requests.some(
        (request) =>
          request.path === "/repos/fullbeam-labs/relaydesk/issues" &&
          request.method === "POST",
      ),
    ).toBe(false);
    expect(
      stub.requests.some(
        (request) =>
          request.path ===
            "/repos/fullbeam-labs/relaydesk/git/ref/heads%2Fseed%2Ftenant-isolation" &&
          request.method === "GET",
      ),
    ).toBe(true);
    expect(
      stub.requests.find(
        (request) =>
          request.path.endsWith("/git/trees") && request.method === "POST",
      )?.body,
    ).toEqual({
      base_tree: "old-tree",
      tree: [
        { path: "src/app.ts", mode: "100644", type: "blob", sha: "new-blob" },
        { path: "src/removed.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
  });
});

describe("GitHubActions", () => {
  it("encrypts an Actions secret and refuses to upload the bootstrap token", async () => {
    const sodium = await import("libsodium-wrappers");
    await sodium.default.ready;
    const keyPair = sodium.default.crypto_box_keypair();
    const publicKey = sodium.default.to_base64(
      keyPair.publicKey,
      sodium.default.base64_variants.ORIGINAL,
    );
    const stub = await stubGitHub((request) => {
      if (request.path.endsWith("/actions/secrets/public-key"))
        return { body: { key_id: "key-1", key: publicKey } };
      if (
        request.path.endsWith("/actions/secrets/INSTACLOUD_TOKEN") &&
        request.method === "PUT"
      )
        return { status: 204 };
      return { status: 404, body: { message: "not found" } };
    });
    const client = new GitHubClient({
      token: "bootstrap-token",
      repository: identity(stub.baseUrl),
    });
    const actions = new GitHubActions(client);

    await actions.putSecret("INSTACLOUD_TOKEN", "provider-token");
    await expect(
      actions.putSecret("FULLBEAM_GITHUB_TOKEN", "bootstrap-token"),
    ).rejects.toThrow(/authentication token/i);

    const write = stub.requests.find((request) => request.method === "PUT");
    expect(JSON.stringify(write?.body)).not.toContain("provider-token");
    expect(
      JSON.stringify(stub.requests.map((request) => request.body)),
    ).not.toContain("bootstrap-token");
  });

  it("paginates the wrapped Actions artifact collection", async () => {
    const stub = await stubGitHub((request) => {
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/actions/runs/99/artifacts?per_page=100"
      )
        return {
          headers: {
            link: `<${stub.baseUrl}/repos/fullbeam-labs/relaydesk/actions/runs/99/artifacts?per_page=100&page=2>; rel=\"next\"`,
          },
          body: {
            total_count: 2,
            artifacts: [
              {
                id: 1,
                name: "first",
                size_in_bytes: 1,
                expired: false,
                created_at: "2026-01-01T00:00:00Z",
                expires_at: "2026-02-01T00:00:00Z",
              },
            ],
          },
        };
      if (request.path.endsWith("page=2"))
        return {
          body: {
            total_count: 2,
            artifacts: [
              {
                id: 2,
                name: "second",
                size_in_bytes: 2,
                expired: false,
                created_at: "2026-01-01T00:00:00Z",
                expires_at: "2026-02-01T00:00:00Z",
              },
            ],
          },
        };
      return { status: 404, body: { message: "not found" } };
    });
    const actions = new GitHubActions(
      new GitHubClient({ token: "token", repository: identity(stub.baseUrl) }),
    );

    await expect(actions.listRunArtifacts(99)).resolves.toMatchObject([
      { id: 1, name: "first" },
      { id: 2, name: "second" },
    ]);
  });
});

describe("GitHubPublisher", () => {
  it("updates one marked escaped report and creates a check only for the current exact head", async () => {
    const stub = await stubGitHub((request) => {
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/issues/51/comments?per_page=100"
      )
        return { body: [{ id: 91, body: `${FULLBEAM_COMMENT_MARKER}\nold` }] };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/issues/comments/91" &&
        request.method === "PATCH"
      )
        return { body: { id: 91, html_url: "https://github.test/comment/91" } };
      if (request.path === "/repos/fullbeam-labs/relaydesk/pulls/51")
        return { body: { number: 51, head: { sha: "exact-head" } } };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/check-runs" &&
        request.method === "POST"
      )
        return { body: { id: 123, html_url: "https://github.test/check/123" } };
      return { status: 404, body: { message: "not found" } };
    });
    const publisher = new GitHubPublisher(
      new GitHubClient({
        token: "publish-token",
        repository: identity(stub.baseUrl),
      }),
    );

    const result = await publisher.publish({
      pullNumber: 51,
      expectedHeadSha: "exact-head",
      title: "Comparison <unsafe>",
      reportText: "```html\n<script>alert(1)</script>\n```",
      check: { name: "fullbeam / evidence", conclusion: "neutral" },
    });

    expect(result.commentId).toBe(91);
    expect(result.checkRunId).toBe(123);
    const commentBody = (
      stub.requests.find((request) =>
        request.path.endsWith("/issues/comments/91"),
      )?.body as { body: string }
    ).body;
    expect(commentBody).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(commentBody).not.toContain("<script>");
    expect(
      stub.requests.find((request) => request.path.endsWith("/check-runs"))
        ?.body,
    ).toMatchObject({
      head_sha: "exact-head",
      name: "fullbeam / evidence",
      conclusion: "neutral",
    });
  });

  it("rejects a moved head by default and explicitly marks an allowed old-head publication OUTDATED", async () => {
    const stub = await stubGitHub((request) => {
      if (request.path === "/repos/fullbeam-labs/relaydesk/pulls/52")
        return { body: { number: 52, head: { sha: "new-head" } } };
      if (
        request.path ===
        "/repos/fullbeam-labs/relaydesk/issues/52/comments?per_page=100"
      )
        return { body: [] };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/issues/52/comments" &&
        request.method === "POST"
      )
        return { body: { id: 92, html_url: "https://github.test/comment/92" } };
      if (
        request.path === "/repos/fullbeam-labs/relaydesk/check-runs" &&
        request.method === "POST"
      )
        return { body: { id: 124, html_url: "https://github.test/check/124" } };
      return { status: 404, body: { message: "not found" } };
    });
    const publisher = new GitHubPublisher(
      new GitHubClient({
        token: "publish-token",
        repository: identity(stub.baseUrl),
      }),
    );
    const input = {
      pullNumber: 52,
      expectedHeadSha: "old-head",
      title: "Comparison",
      reportText: "complete",
      check: {
        name: "fullbeam / execution" as const,
        conclusion: "success" as const,
      },
    };

    await expect(publisher.publish(input)).rejects.toThrow(/head changed/i);
    const result = await publisher.publish({ ...input, allowOutdated: true });

    expect(result.applicability).toBe("OUTDATED");
    const comment = stub.requests.find(
      (request) =>
        request.path.endsWith("/issues/52/comments") &&
        request.method === "POST",
    );
    expect((comment?.body as { body: string }).body).toContain(
      "APPLICABILITY: OUTDATED",
    );
    expect(
      stub.requests.find((request) => request.path.endsWith("/check-runs"))
        ?.body,
    ).toMatchObject({ head_sha: "old-head" });
  });
});
