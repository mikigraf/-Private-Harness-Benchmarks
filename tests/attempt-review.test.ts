import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { Config } from "../src/core/config.js";
import {
  digest,
  makeFile,
  overlayFiles,
  recordDigest,
  type FileEntry,
} from "../src/core/integrity.js";
import { resolveHarnessForComparison } from "../src/harness/resolve.js";
import { GitHubClient } from "../src/github/client.js";
import {
  createAttemptReviewPr,
  type AttemptReviewPrInput,
} from "../src/product/attempt-review.js";

const config = {
  repository: "owned/demo",
  githubToken: "synthetic-token",
  openaiKey: "synthetic-openai-secret",
  instacloudToken: "synthetic-insta-secret",
} as Config;
const baseSha = "a".repeat(40);
const native = (model = "model-before") =>
  `model="${model}"\nmodel_reasoning_effort="medium"\napproval_policy="never"\nsandbox_mode="workspace-write"\nweb_search="disabled"\n`;
const manifest = (files: FileEntry[]) =>
  files.map(({ content: _, ...file }) => file);
function inputFixture(): AttemptReviewPrInput {
  const release = resolveHarnessForComparison(
    [
      makeFile("AGENTS.md", "Follow frozen contracts.\n"),
      makeFile(".codex/config.toml", native("candidate-model")),
    ],
    "b".repeat(40),
    { generation: "c".repeat(64), application: "d".repeat(64) },
    "candidate",
  );
  const taskSource = [
    makeFile("src/app.ts", "export const bug = true;\n"),
    makeFile("src/obsolete.ts", "remove me\n"),
    makeFile("tests/public/health.test.ts", "protected public test\n"),
    makeFile("package.json", '{"name":"snapshot"}\n'),
  ];
  const before = overlayFiles(taskSource, release.files);
  const after = overlayFiles(
    before.filter((f) => f.path !== "src/obsolete.ts"),
    [
      makeFile("src/app.ts", "export const bug = false;\n"),
      makeFile("tests/agent/check.sh", "#!/bin/sh\nexit 0\n", 0o100755),
    ],
  );
  const generation = {
    executionId: "real-capture",
    role: "generation" as const,
    startedAt: "2026-09-18T22:00:00Z",
    endedAt: "2026-09-18T22:00:01Z",
    durationMs: 1000,
    status: "COMPLETED" as const,
    exitCode: 0,
    checks: [],
    files: after,
    beforeManifest: manifest(before),
    afterManifest: manifest(after),
    violations: [],
    events: "captured native events",
    stderr: "",
    logsTruncated: false,
    usage: [],
    integrityVerified: true,
  };
  const generationDigest = digest(generation);
  const slot = {
    id: "comparison-task-candidate-r1",
    task_id: "tenant-idempotency",
    task_digest: "e".repeat(64),
    release_id: "candidate" as const,
    release_digest: release.release.digest,
    repeat: 1 as const,
    block_id: "task-r1",
    order: 1,
  };
  const schedule = ["current", "candidate"].flatMap((release_id, i) =>
    ([1, 2] as const).map((repeat, j) => ({
      task_id: slot.task_id,
      release_id,
      repeat,
      block_id: `task-r${repeat}`,
      order: 2 * j + i,
    })),
  );
  return {
    taskSource,
    release,
    generation,
    generationDigest,
    comparison: {
      kind: "Comparison",
      schema_version: 1,
      id: "comparison",
      repository_id: "77",
      candidate_pr: 10,
      candidate_head_sha: "b".repeat(40),
      baseline_source_sha: baseSha,
      benchmark_source_sha: baseSha,
      controller_commit_sha: baseSha,
      current_release_digest: "f".repeat(64),
      candidate_release_digest: release.release.digest,
      benchmark_digest: "0".repeat(64),
      policy_digest: "1".repeat(64),
      created_at: "2026-09-18T22:00:00Z",
      trigger_actor: "maintainer",
      github_actions_run_id: "12345",
      evidence_maturity: "PIPELINE_DEMO",
      schedule,
      release_decision: "NOT_QUALIFIED_FOR_PRODUCTION",
    },
    envelope: {
      slot,
      run: {
        kind: "Run",
        schema_version: 1,
        id: slot.id,
        comparison_id: "comparison",
        task_digest: slot.task_digest,
        release_digest: slot.release_digest,
        block_id: slot.block_id,
        repeat: slot.repeat,
        started_at: generation.startedAt,
        finished_at: generation.endedAt,
        outcome: "PASS",
        phase: "COMPLETE",
        reason: "Observed checks passed",
        checks: [
          {
            test_id: "checks-pass",
            group: "FAIL_TO_PASS",
            outcome: "PASS",
            evidence_artifact_id: "2".repeat(64),
          },
        ],
        agent_duration_ms: 1000,
        total_duration_ms: 2000,
        usage: null,
        estimated_model_cost: null,
        rate_record_artifact_id: null,
        artifacts: [
          {
            id: generationDigest,
            sha256: generationDigest,
            media_type: "application/json",
          },
        ],
        environment_ids: ["generation-owned", "verification-owned"],
        cleanup_status: "CONFIRMED",
        replaces_run_id: null,
      },
    },
  };
}
function bindGeneration(input: AttemptReviewPrInput) {
  input.generation.afterManifest = manifest(input.generation.files);
  input.generationDigest = digest(input.generation);
  input.envelope.run.artifacts = [
    {
      id: input.generationDigest,
      sha256: input.generationDigest,
      media_type: "application/json",
    },
  ];
}

/** Exercise real client/bootstrap/freeze code against the GitHub REST boundary. */
function fixture() {
  const requests: { method: string; path: string; body: any }[] = [];
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, { sha: string; mode: string }>>();
  const commits = new Map<string, any>();
  const refs = new Map<string, string>([["main", baseSha]]);
  const pulls: any[] = [];
  let sequence = 0,
    protectedBranch = true,
    privateRepo = true,
    failPullCreation = false;
  const oid = () =>
    createHash("sha1").update(`fixture-${++sequence}`).digest("hex");
  const blob = (text: string | Buffer) => {
    const bytes = Buffer.from(text),
      sha = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    blobs.set(sha, bytes);
    return sha;
  };
  const initial = new Map(
    Object.entries({
      ".codex/config.toml": native(),
      "AGENTS.md": "Follow repository contracts.\n",
      "skills.md": "Human skill index.\n",
      ".agents/skills/check/SKILL.md":
        "---\nname: check\ndescription: Check behavior.\n---\nRun public tests.\n",
      "src/app.ts": "export const application = true;\n",
      ".github/workflows/controller.yml": "protected controller\n",
    }).map(([path, text]) => [path, { sha: blob(text), mode: "100644" }]),
  );
  const baseTree = oid();
  trees.set(baseTree, initial);
  commits.set(baseSha, {
    tree: { sha: baseTree },
    parents: [],
    message: "protected baseline",
    author: { login: "maintainer" },
  });
  const exposePull = (p: any) => ({
    ...p,
    head: { ...p.head, sha: refs.get(p.head.ref) },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    const method = init?.method ?? "GET",
      path = decodeURIComponent(url.pathname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    const respond = (value: any, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/user") return respond({ login: "maintainer", id: 11 });
    const suffix = path.replace(/^\/repos\/owned\/demo\/?/, "");
    if (method === "GET" && suffix === "")
      return respond({
        id: 77,
        full_name: "owned/demo",
        private: privateRepo,
        default_branch: "main",
      });
    if (method === "GET" && suffix === "branches/main")
      return respond({ protected: protectedBranch });
    if (method === "GET" && suffix.startsWith("git/ref/heads/")) {
      const sha = refs.get(suffix.slice("git/ref/heads/".length));
      return sha ? respond({ object: { sha } }) : respond({}, 404);
    }
    if (method === "GET" && suffix.startsWith("git/trees/")) {
      const ref = suffix.slice("git/trees/".length),
        sha = commits.get(ref)?.tree.sha ?? ref,
        tree = trees.get(sha)!;
      return respond({
        sha,
        truncated: false,
        tree: [...tree].map(([path, f]) => ({
          ...f,
          path,
          type: "blob",
          size: blobs.get(f.sha)!.length,
        })),
      });
    }
    if (method === "GET" && suffix.startsWith("git/blobs/")) {
      const sha = suffix.slice("git/blobs/".length),
        bytes = blobs.get(sha)!;
      return respond({
        sha,
        encoding: "base64",
        content: bytes.toString("base64"),
        size: bytes.length,
      });
    }
    if (method === "GET" && suffix.startsWith("git/commits/"))
      return respond(commits.get(suffix.slice("git/commits/".length)));
    if (method === "GET" && suffix.startsWith("commits/")) {
      const requested = suffix.slice("commits/".length),
        sha = refs.get(requested) ?? requested,
        c = commits.get(sha);
      return c
        ? respond({
            sha,
            author: c.author,
            commit: { message: c.message },
            parents: c.parents,
          })
        : respond({}, 404);
    }
    if (method === "POST" && suffix === "git/blobs")
      return respond({ sha: blob(Buffer.from(body.content, "base64")) }, 201);
    if (method === "POST" && suffix === "git/trees") {
      const tree = new Map(trees.get(body.base_tree)!);
      for (const f of body.tree) {
        if (f.sha === null) tree.delete(f.path);
        else tree.set(f.path, { sha: f.sha, mode: f.mode });
      }
      const sha = oid();
      trees.set(sha, tree);
      return respond({ sha }, 201);
    }
    if (method === "POST" && suffix === "git/commits") {
      const sha = oid();
      commits.set(sha, {
        tree: { sha: body.tree },
        parents: body.parents.map((sha: string) => ({ sha })),
        message: body.message,
        author: { login: "maintainer" },
      });
      return respond({ sha }, 201);
    }
    if (method === "POST" && suffix === "git/refs") {
      const branch = body.ref.slice("refs/heads/".length);
      if (refs.has(branch)) return respond({}, 422);
      refs.set(branch, body.sha);
      return respond({ object: { sha: body.sha } }, 201);
    }
    if (method === "PATCH" && suffix.startsWith("git/refs/heads/")) {
      expect(body.force).toBe(false);
      const branch = suffix.slice("git/refs/heads/".length);
      if (commits.get(body.sha).parents[0]?.sha !== refs.get(branch))
        return respond({}, 422);
      refs.set(branch, body.sha);
      return respond({ object: { sha: body.sha } });
    }
    if (method === "GET" && suffix === "pulls")
      return respond(
        pulls
          .filter(
            (p) => `${"owned"}:${p.head.ref}` === url.searchParams.get("head"),
          )
          .map(exposePull),
      );
    if (method === "POST" && suffix === "pulls") {
      if (failPullCreation) {
        failPullCreation = false;
        return respond({}, 503);
      }
      const number = pulls.length + 1;
      const p = {
        number,
        html_url: `https://github.com/owned/demo/pull/${number}`,
        state: "open",
        title: body.title,
        body: body.body,
        draft: body.draft,
        user: { login: "maintainer" },
        head: { ref: body.head, repo: { id: 77 } },
        base: { ref: body.base, sha: refs.get(body.base), repo: { id: 77 } },
      };
      pulls.push(p);
      return respond(exposePull(p), 201);
    }
    if (
      (method === "PATCH" || method === "GET") &&
      /^pulls\/\d+$/.test(suffix)
    ) {
      const p = pulls[Number(suffix.split("/")[1]) - 1];
      if (method === "PATCH") Object.assign(p, body);
      return respond(exposePull(p));
    }
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  const client = new GitHubClient({
    token: "synthetic-token",
    repository: { owner: "owned", repo: "demo", repositoryId: 77 },
    fetch,
  });
  return {
    client,
    requests,
    refs,
    pulls,
    commits,
    mutations: () => requests.filter((r) => r.method !== "GET"),
    files: (sha: string) =>
      Object.fromEntries(
        [...trees.get(commits.get(sha).tree.sha)!].map(([p, f]) => [
          p,
          { text: blobs.get(f.sha)!.toString(), mode: f.mode },
        ]),
      ),
    unprotect: () => {
      protectedBranch = false;
    },
    makePublic: () => {
      privateRepo = false;
    },
    failPull: () => {
      failPullCreation = true;
    },
    changeBranch: (branch: string, path: string, text: string | null) => {
      const prior = refs.get(branch)!,
        tree = new Map(trees.get(commits.get(prior).tree.sha)!);
      if (text === null) tree.delete(path);
      else tree.set(path, { sha: blob(text), mode: "100644" });
      const treeSha = oid();
      trees.set(treeSha, tree);
      const sha = oid();
      commits.set(sha, {
        tree: { sha: treeSha },
        parents: [{ sha: prior }],
        message: "unrelated manual edit",
        author: { login: "other" },
      });
      refs.set(branch, sha);
    },
  };
}

it("creates one draft PR containing the exact captured patch against an orphan task+harness snapshot, and reuses it without mutations", async () => {
  const f = fixture(),
    input = inputFixture();
  const result = await createAttemptReviewPr(config, input, {
    client: f.client,
  });
  expect(result).toMatchObject({
    repository: "owned/demo",
    runId: 12345,
    comparisonId: "comparison",
    attemptId: input.envelope.run.id,
    generationDigest: input.generationDigest,
    pr: 1,
    url: "https://github.com/owned/demo/pull/1",
  });
  expect(f.pulls[0].draft).toBe(true);
  expect(f.pulls[0].base.ref).toBe(result.baseBranch);
  expect(f.pulls[0].head.ref).toBe(result.headBranch);
  expect(f.commits.get(result.baseSha).parents).toEqual([]);
  expect(f.commits.get(result.headSha).parents).toEqual([
    { sha: result.baseSha },
  ]);
  expect(f.files(result.baseSha)).toEqual(
    Object.fromEntries(
      overlayFiles(input.taskSource, input.release.files).map((file) => [
        file.path,
        {
          text: Buffer.from(file.content, "base64").toString(),
          mode: file.mode & 0o111 ? "100755" : "100644",
        },
      ]),
    ),
  );
  expect(f.files(result.headSha)).toEqual(
    Object.fromEntries(
      input.generation.files.map((file) => [
        file.path,
        {
          text: Buffer.from(file.content, "base64").toString(),
          mode: file.mode & 0o111 ? "100755" : "100644",
        },
      ]),
    ),
  );
  expect(f.refs.get("main")).toBe(baseSha);
  expect(f.pulls[0].body).toContain("/pull/10");
  expect(f.pulls[0].body).toContain("/actions/runs/12345");
  expect(f.pulls[0].body).toContain(input.generationDigest);
  const count = f.mutations().length;
  expect(
    await createAttemptReviewPr(config, input, { client: f.client }),
  ).toEqual(result);
  expect(f.mutations()).toHaveLength(count);
  expect(f.mutations().every((r) => r.method === "POST")).toBe(true);
});

it("recovers after PR creation failure using only the owned immutable branches", async () => {
  const f = fixture(),
    input = inputFixture();
  f.failPull();
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow();
  const refs = new Map(f.refs);
  const result = await createAttemptReviewPr(config, input, {
    client: f.client,
  });
  expect(f.refs).toEqual(refs);
  expect(result.pr).toBe(1);
  expect(f.pulls).toHaveLength(1);
});

it("refuses a manually moved owned branch instead of overwriting it", async () => {
  const f = fixture(),
    input = inputFixture();
  const result = await createAttemptReviewPr(config, input, {
    client: f.client,
  });
  f.changeBranch(result.headBranch, "src/app.ts", "manual content");
  const count = f.mutations().length;
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow(/ownership|changed|snapshot/i);
  expect(f.mutations()).toHaveLength(count);
});

it.each([
  ".github/workflows/injected.yml",
  ".fullbeam/private/reference.json",
  ".env",
  "src/.env.local",
  "secrets/id_rsa",
  "src/credentials.json",
  ".npmrc",
])(
  "refuses unsafe captured path %s before any GitHub mutation",
  async (path) => {
    const f = fixture(),
      input = inputFixture();
    input.generation.files.push(makeFile(path, "unsafe file"));
    bindGeneration(input);
    await expect(
      createAttemptReviewPr(config, input, { client: f.client }),
    ).rejects.toThrow(/unsafe|credential|publish/i);
    expect(f.mutations()).toHaveLength(0);
  },
);

it("refuses protected infrastructure even if present in the frozen baseline", async () => {
  const f = fixture(),
    input = inputFixture();
  const workflow = makeFile(".github/workflows/source.yml", "name: unsafe\n");
  input.taskSource.push(workflow);
  input.generation.beforeManifest.push(...manifest([workflow]));
  input.generation.files.push(workflow);
  bindGeneration(input);
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow(/unsafe|publish/i);
  expect(f.mutations()).toHaveLength(0);
});

it("refuses known secrets in captured content without redacting and publishing a different patch", async () => {
  const f = fixture(),
    input = inputFixture();
  input.generation.files.push(makeFile("src/leak.ts", config.openaiKey));
  bindGeneration(input);
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow(/credential|secret/i);
  expect(f.mutations()).toHaveLength(0);
});

it("allows an honestly labeled policy-violating public-test edit for review", async () => {
  const f = fixture(),
    input = inputFixture();
  input.generation.files = overlayFiles(input.generation.files, [
    makeFile(
      "tests/public/health.test.ts",
      "model changed this protected test\n",
    ),
  ]);
  input.envelope.run.outcome = "POLICY_VIOLATION";
  input.generation.violations.push("tests/public/health.test.ts");
  bindGeneration(input);
  const result = await createAttemptReviewPr(config, input, {
    client: f.client,
  });
  expect(f.files(result.headSha)["tests/public/health.test.ts"]!.text).toBe(
    "model changed this protected test\n",
  );
  expect(f.pulls[0].body).toContain("POLICY_VIOLATION");
});

it.each([
  "artifact",
  "before",
  "after",
  "comparison",
  "release",
  "repo",
  "public",
  "unchanged",
])("refuses %s mismatch before mutations", async (kind) => {
  const f = fixture(),
    input = inputFixture();
  if (kind === "artifact") input.generationDigest = "0".repeat(64);
  if (kind === "before")
    input.taskSource[0] = makeFile("src/app.ts", "wrong base");
  if (kind === "after") {
    input.generation.afterManifest = [];
    input.generationDigest = digest(input.generation);
    input.envelope.run.artifacts[0] = {
      id: input.generationDigest,
      sha256: input.generationDigest,
      media_type: "application/json",
    };
  }
  if (kind === "comparison") input.envelope.run.comparison_id = "other";
  if (kind === "release") input.envelope.slot.release_id = "current";
  if (kind === "repo") input.comparison.repository_id = "78";
  if (kind === "public") f.makePublic();
  if (kind === "unchanged") {
    input.generation.files = overlayFiles(
      input.taskSource,
      input.release.files,
    );
    bindGeneration(input);
  }
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow();
  expect(f.mutations()).toHaveLength(0);
});

it("preserves only unchanged historical controller AGENTS instructions and rejects introduced or changed metadata", async () => {
  const f = fixture(),
    input = inputFixture();
  const path = ".fullbeam/controller/templates/relaydesk/generation/AGENTS.md";
  const historical = makeFile(path, "Frozen general instructions only.\n");
  // Real old captures included these inert files via recursive native AGENTS selection.
  const release = structuredClone(input.release);
  release.files.push(historical);
  release.release.native_files.push({ path, sha256: historical.sha256 });
  release.release.digest = recordDigest(
    release.release as unknown as Record<string, unknown>,
  );
  input.release = release;
  input.comparison.candidate_release_digest = release.release.digest;
  input.envelope.slot.release_digest = release.release.digest;
  input.envelope.run.release_digest = release.release.digest;
  input.generation.beforeManifest = manifest(
    overlayFiles(input.taskSource, release.files),
  );
  input.generation.files.push(historical);
  bindGeneration(input);
  const result = await createAttemptReviewPr(config, input, {
    client: f.client,
  });
  expect(f.files(result.baseSha)[path]).toEqual(f.files(result.headSha)[path]);
  for (const mutation of ["edit", "add", "delete", "mode"]) {
    const changed = structuredClone(input),
      other = fixture();
    if (mutation === "edit")
      changed.generation.files = overlayFiles(changed.generation.files, [
        makeFile(path, "changed controller instructions"),
      ]);
    if (mutation === "add")
      changed.generation.files.push(
        makeFile(".fullbeam/controller/other/AGENTS.md", "introduced file"),
      );
    if (mutation === "delete")
      changed.generation.files = changed.generation.files.filter(
        (file) => file.path !== path,
      );
    if (mutation === "mode")
      changed.generation.files = overlayFiles(changed.generation.files, [
        makeFile(path, "Frozen general instructions only.\n", 0o100755),
      ]);
    bindGeneration(changed);
    await expect(
      createAttemptReviewPr(config, changed, { client: other.client }),
    ).rejects.toThrow(/unsafe/);
    expect(other.mutations()).toHaveLength(0);
  }
});

it("refuses a captured database password before any publication", async () => {
  const f = fixture(),
    input = inputFixture();
  input.generation.files.push(makeFile("src/leak.ts", "decoded-db-password"));
  bindGeneration(input);
  await expect(
    createAttemptReviewPr(
      {
        ...config,
        databaseUrl:
          "postgresql://user:decoded-db-password@database.invalid/db?sslmode=verify-full",
      },
      input,
      { client: f.client },
    ),
  ).rejects.toThrow(/secret/);
  expect(f.mutations()).toHaveLength(0);
});

it("refuses known secret bytes in captured filenames before Git object creation", async () => {
  const f = fixture(),
    input = inputFixture();
  input.generation.files.push(
    makeFile(`src/${config.openaiKey}.ts`, "innocent content"),
  );
  bindGeneration(input);
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow(/secret/);
  expect(f.mutations()).toHaveLength(0);
});

it("accepts canonical GitHub PR URLs with differently cased operator repository configuration", async () => {
  const f = fixture(),
    input = inputFixture();
  const result = await createAttemptReviewPr(
    { ...config, repository: "Owned/Demo" },
    input,
    { client: f.client },
  );
  expect(result.url).toBe("https://github.com/owned/demo/pull/1");
  expect(result.repository).toBe("Owned/Demo");
  expect(
    await createAttemptReviewPr(
      { ...config, repository: "Owned/Demo" },
      input,
      { client: f.client },
    ),
  ).toEqual(result);
});

it.each([
  "https://github.com/owned/demo/pull/1?redirect=other",
  "https://github.com/owned/demo/pull/1#other",
  "https://user:password@github.com/owned/demo/pull/1",
  "http://github.com/owned/demo/pull/1",
  "https://github.com/other/repo/pull/1",
])("refuses unsafe returned PR URL %s", async (url) => {
  const f = fixture(),
    input = inputFixture();
  await createAttemptReviewPr(config, input, { client: f.client });
  f.pulls[0].html_url = url;
  const count = f.mutations().length;
  await expect(
    createAttemptReviewPr(config, input, { client: f.client }),
  ).rejects.toThrow(/ownership|binding/);
  expect(f.mutations()).toHaveLength(count);
});
