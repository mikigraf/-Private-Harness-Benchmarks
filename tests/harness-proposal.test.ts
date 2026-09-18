import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse as parseToml } from "@iarna/toml";
import type { Config } from "../src/core/config.js";
import { GitHubClient } from "../src/github/client.js";
import {
  createHarnessProposal,
  readHarnessSnapshot,
} from "../src/product/harness.js";

const config = {
  repository: "owned/demo",
  githubToken: "synthetic-token",
} as Config;
const baseSha = "a".repeat(40);
const native = (model = "model-before", effort = "medium") =>
  `model="${model}"\nmodel_reasoning_effort="${effort}"\napproval_policy="never"\nsandbox_mode="workspace-write"\nweb_search="disabled"\n`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function overlay(
  files: Record<string, string | { text: string; mode: number }>,
) {
  const dir = await mkdtemp(join(tmpdir(), "fullbeam-harness-overlay-"));
  directories.push(dir);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof value === "string" ? value : value.text,
      { mode: typeof value === "string" ? 0o644 : value.mode },
    );
  }
  return dir;
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

it("creates a model-only PR from protected default without mutating source or default", async () => {
  const f = fixture();
  const result = await createHarnessProposal(
    config,
    { name: "other-model", model: "model-after" },
    { client: f.client },
  );
  expect(result.classification).toBe("MODEL_ONLY");
  expect(result.changedPaths).toEqual([".codex/config.toml"]);
  expect(f.refs.get("main")).toBe(baseSha);
  expect(f.commits.get(result.head).parents).toEqual([{ sha: baseSha }]);
  expect(parseToml(f.files(result.head)[".codex/config.toml"]!.text)).toEqual({
    model: "model-after",
    model_reasoning_effort: "medium",
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    web_search: "disabled",
  });
  expect(f.files(result.head)["src/app.ts"]).toEqual(
    f.files(baseSha)["src/app.ts"],
  );
  expect(f.mutations().filter((r) => r.path.endsWith("/pulls"))).toHaveLength(
    1,
  );
});

it("exports native editable files and accepts a complete native overlay with explicit flag precedence", async () => {
  const f = fixture(),
    snapshot = await readHarnessSnapshot(config, {}, { client: f.client });
  expect(snapshot.head).toBe(baseSha);
  expect(snapshot.files.map((x) => x.path)).toEqual([
    ".agents/skills/check/SKILL.md",
    ".codex/config.toml",
    "AGENTS.md",
    "skills.md",
  ]);
  expect(f.mutations()).toHaveLength(0);
  const files = Object.fromEntries(
    snapshot.files.map((x) => [
      x.path,
      Buffer.from(x.content, "base64").toString(),
    ]),
  );
  files[".codex/config.toml"] = native("overlay-model", "high");
  files["skills.md"] = "Updated human index.\n";
  const dir = await overlay({
    ...files,
    ".agents/skills/check/scripts/prove.sh": {
      text: "#!/bin/sh\nexit 99\n",
      mode: 0o755,
    },
  });
  const result = await createHarnessProposal(
    config,
    { name: "native-overlay", overlayDir: dir, model: "flag-model" },
    { client: f.client },
  );
  expect(result.classification).toBe("BUNDLE");
  const tree = f.files(result.head);
  expect(parseToml(tree[".codex/config.toml"]!.text).model).toBe("flag-model");
  expect(
    parseToml(tree[".codex/config.toml"]!.text).model_reasoning_effort,
  ).toBe("high");
  expect(tree[".agents/skills/check/scripts/prove.sh"]!.mode).toBe("100755");
});

it("updates only its owned proposal with a non-forced append and replays without duplicate commits or PRs", async () => {
  const f = fixture();
  const first = await createHarnessProposal(
    config,
    { name: "repeat", model: "model-after" },
    { client: f.client },
  );
  const dir = await overlay({ "AGENTS.md": "Changed instructions.\n" });
  const second = await createHarnessProposal(
    config,
    { name: "repeat", overlayDir: dir },
    { client: f.client },
  );
  expect(second.pr).toBe(first.pr);
  expect(second.classification).toBe("BUNDLE");
  expect(f.commits.get(second.head).parents).toEqual([{ sha: first.head }]);
  const writes = f.mutations().length;
  const replay = await createHarnessProposal(
    config,
    { name: "repeat", overlayDir: dir },
    { client: f.client },
  );
  expect(replay.head).toBe(second.head);
  expect(f.mutations()).toHaveLength(writes);
  expect(f.pulls).toHaveLength(1);
});

it("recovers only its own exact initial commit if PR creation failed", async () => {
  const f = fixture();
  f.failPull();
  await expect(
    createHarnessProposal(
      config,
      { name: "recover", model: "model-after" },
      { client: f.client },
    ),
  ).rejects.toThrow(/503/);
  const head = f.refs.get("fullbeam/harness/recover");
  const result = await createHarnessProposal(
    config,
    { name: "recover", model: "model-after" },
    { client: f.client },
  );
  expect(result.head).toBe(head);
  expect(f.pulls).toHaveLength(1);
});

it.each([
  "unowned-branch",
  "foreign-source",
  "moved-default",
  "other-author",
  "missing-marker",
])("rejects %s before modifying an existing branch", async (kind) => {
  const f = fixture();
  if (kind === "unowned-branch")
    f.refs.set("fullbeam/harness/existing", baseSha);
  else {
    await createHarnessProposal(
      config,
      { name: "existing", model: "model-after" },
      { client: f.client },
    );
    if (kind === "foreign-source")
      f.changeBranch(
        "fullbeam/harness/existing",
        "src/app.ts",
        "unauthorized edit",
      );
    if (kind === "moved-default")
      f.changeBranch("main", "src/app.ts", "new protected baseline");
    if (kind === "other-author") f.pulls[0].user.login = "other";
    if (kind === "missing-marker")
      f.pulls[0].body = f.pulls[0].body.replace(
        /<!-- fullbeam:seed:pull:[^>]+ -->/,
        "",
      );
  }
  const writes = f.mutations().length;
  await expect(
    createHarnessProposal(
      config,
      { name: "existing", model: "another-model" },
      { client: f.client },
    ),
  ).rejects.toThrow(/owned|non-harness|protected default/);
  expect(f.mutations()).toHaveLength(writes);
});

it("reports an existing owned proposal's deleted harness files without restoring them", async () => {
  const f = fixture();
  await createHarnessProposal(
    config,
    { name: "deletion", model: "model-after" },
    { client: f.client },
  );
  f.changeBranch("fullbeam/harness/deletion", "skills.md", null);
  const result = await createHarnessProposal(
    config,
    { name: "deletion", model: "model-after" },
    { client: f.client },
  );
  expect(result.classification).toBe("BUNDLE");
  expect(result.changedPaths).toEqual([".codex/config.toml", "skills.md"]);
  expect(f.files(result.head)["skills.md"]).toBeUndefined();
});

it.each([
  "src/app.ts",
  ".github/workflows/run.yml",
  ".env",
  ".codex/other.toml",
])("rejects arbitrary overlay %s before any API request", async (path) => {
  const f = fixture(),
    dir = await overlay({ [path]: "must not upload" });
  await expect(
    createHarnessProposal(
      config,
      { name: "unsafe", overlayDir: dir },
      { client: f.client },
    ),
  ).rejects.toThrow(/not editable harness/);
  expect(f.requests).toHaveLength(0);
});

it("rejects permission overrides, unsupported effort, and overlay links without writes", async () => {
  const f = fixture();
  const permission = await overlay({
    ".codex/config.toml": native().replace(
      "workspace-write",
      "danger-full-access",
    ),
  });
  await expect(
    createHarnessProposal(
      config,
      { name: "unsafe", overlayDir: permission },
      { client: f.client },
    ),
  ).rejects.toThrow(/workspace-write/);
  const effort = await overlay({
    ".codex/config.toml": native().replace('"medium"', "7"),
  });
  await expect(
    createHarnessProposal(
      config,
      { name: "unsafe", overlayDir: effort },
      { client: f.client },
    ),
  ).rejects.toThrow(/model_reasoning_effort/);
  const linked = await overlay({});
  await symlink("/does-not-exist", join(linked, "AGENTS.md"));
  await expect(
    createHarnessProposal(
      config,
      { name: "unsafe", overlayDir: linked },
      { client: f.client },
    ),
  ).rejects.toThrow(/Unsafe overlay/);
  expect(f.mutations()).toHaveLength(0);
});

it("refuses an unprotected/public default and a semantic no-op", async () => {
  const unprotected = fixture();
  unprotected.unprotect();
  await expect(
    createHarnessProposal(
      config,
      { name: "unsafe", model: "changed" },
      { client: unprotected.client },
    ),
  ).rejects.toThrow(/protected/);
  const publicRepo = fixture();
  publicRepo.makePublic();
  await expect(
    readHarnessSnapshot(config, {}, { client: publicRepo.client }),
  ).rejects.toThrow(/private/);
  const unchanged = fixture();
  await expect(
    createHarnessProposal(
      config,
      { name: "noop", model: "model-before" },
      { client: unchanged.client },
    ),
  ).rejects.toThrow(/no effective/);
  for (const f of [unprotected, publicRepo, unchanged])
    expect(f.mutations()).toHaveLength(0);
});
