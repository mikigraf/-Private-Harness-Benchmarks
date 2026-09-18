import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateBundle,
  branchName,
  InstacloudExecutor,
} from "../src/execution/instacloud.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (path: string, content = "hello") => ({
  path,
  content: Buffer.from(content).toString("base64"),
  size: Buffer.byteLength(content),
  sha256: sha(content),
  mode: 0o100644,
});
describe("managed CLI identity", () => {
  it("surfaces an agent approval and never retries the denied project link as a human", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-cli-denial-"));
    const cli = join(dir, "insta");
    const callsFile = join(dir, "calls.jsonl");
    await writeFile(
      cli,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args.slice(0, 3)) + "\\n");
if (args[0] !== "--agent") { console.error("human fallback forbidden"); process.exit(9); }
if (args[1] === "login") { console.log("logged in"); }
else { console.error("approval required: insta agent approvals approve approval-id"); process.exit(2); }
`,
      { mode: 0o700 },
    );
    const executor = new InstacloudExecutor({
      apiKey: "insta_synthetic",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      cliPath: cli,
    });
    try {
      await expect(
        executor.destroy({
          id: "test",
          role: "generation",
          projectId: "gen",
          branch: branchName("test"),
        }),
      ).rejects.toThrow("insta agent approvals approve approval-id");
      expect(
        (await readFile(callsFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ["--agent", "login", "--api-key"],
        ["--agent", "project", "link"],
      ]);
    } finally {
      await executor.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("uses explicit agent mode and separately enrolls each project without copying the user's session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-cli-contract-"));
    const cli = join(dir, "insta");
    const callsFile = join(dir, "calls.jsonl");
    await writeFile(
      cli,
      `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.shift() !== "--agent") { console.error("explicit agent mode required"); process.exit(3); }
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: args.slice(0, 2), cwd: process.cwd(), home: process.env.HOME, project: process.env.INSTA_PROJECT_ID }) + "\\n");
if (args[0] === "login") { console.log("logged in"); }
else if (args[0] === "project" && args[1] === "link") { writeFileSync(join(process.cwd(), "enrolled"), args[2]); console.log(JSON.stringify({ project: { id: args[2] } })); }
else if (args[0] === "branch" && args[1] === "list") { if (!existsSync(join(process.cwd(), "enrolled"))) { console.error("agent session missing"); process.exit(4); } console.log("[]"); }
else { console.error("unexpected command"); process.exit(5); }
`,
      { mode: 0o700 },
    );
    await chmod(cli, 0o700);
    const executor = new InstacloudExecutor({
      apiKey: "insta_synthetic",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      cliPath: cli,
    });
    try {
      for (const [role, projectId] of [
        ["generation", "gen"],
        ["verification", "verify"],
        ["generation", "gen"],
      ] as const)
        await executor.destroy({
          id: "test",
          role,
          projectId,
          branch: branchName("test"),
        });
      const calls = (await readFile(callsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((c) => c.command[0] === "login")).toHaveLength(1);
      const links = calls.filter((c) => c.command[0] === "project");
      expect(links).toHaveLength(2);
      expect(links[0].cwd).not.toBe(links[1].cwd);
      expect(
        calls.filter((c) => c.command[0] === "branch").map((c) => c.project),
      ).toEqual(["gen", "verify", "gen"]);
      expect(calls.every((c) => c.home !== process.env.HOME)).toBe(true);
    } finally {
      await executor.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("bounded file transport", () => {
  it("accepts exact bytes including modes and rejects traversal, malformed base64 and mismatched hashes", () => {
    expect(
      validateBundle({ files: [file("src/index.ts")] }).files,
    ).toHaveLength(1);
    for (const path of [
      "../secret",
      "/secret",
      "a/../secret",
      "a//b",
      "a\\b",
      ".git/config",
      "node_modules/x",
      "src/./x",
    ])
      expect(() => validateBundle({ files: [file(path)] })).toThrow();
    expect(() =>
      validateBundle({ files: [file("src/x"), file("src/x")] }),
    ).toThrow(/duplicate/);
    expect(() =>
      validateBundle({ files: [{ ...file("src/x"), content: "%%%" }] }),
    ).toThrow();
    expect(() =>
      validateBundle({ files: [{ ...file("src/x"), sha256: "0".repeat(64) }] }),
    ).toThrow(/digest/);
    expect(() =>
      validateBundle({ files: [{ ...file("src/x"), mode: 0o120000 }] }),
    ).toThrow(/mode/);
  });
  it("rejects oversized bundles before any transport", () =>
    expect(() =>
      validateBundle({ files: [file("large", "x".repeat(1048577))] }),
    ).toThrow(/limit/));
});
describe("provider lifecycle", () => {
  it("starts a cloned runtime and observes its ready endpoint before allowing attempt work", async () => {
    const calls: string[] = [];
    const image = "registry/runtime@sha256:" + "a".repeat(64);
    const ready = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls.push("ready");
      return new Response('{"service":"fullbeam-runtime","ready":true}');
    });
    const executor = new InstacloudExecutor({
      apiKey: "synthetic",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      runtimeImages: { generation: image, verification: image },
      onEnvironmentIntent: async () => {},
      onEnvironmentAllocated: async () => {},
      transport: async (args) => {
        calls.push(args.slice(0, 2).join(" "));
        if (args[0] === "branch")
          return { branch: { id: "branch-id", name: args[2] } };
        if (args[0] === "service")
          return [{ type: "compute", name: "runtime", image, always_on: true }];
        if (args[0] === "compute" && args[1] === "start")
          return {
            service: { name: "runtime", image, domain: "runtime.example.test" },
            state: "running",
          };
        throw new Error("Unexpected provider request");
      },
    });
    try {
      await executor.createAttemptEnvironment({
        id: "cold-clone",
        role: "generation",
      });
      expect(calls).toEqual([
        "branch create",
        "service list",
        "compute start",
        "ready",
        "service list",
      ]);
      expect(ready.mock.calls[0]?.[0]).toBe("https://runtime.example.test");
    } finally {
      ready.mockRestore();
    }
  });
  it("stops a bundle transfer before the next RPC when its operation deadline expires", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: string[] = [];
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      operationDeadline: () => 2000,
      transport: async (args) => {
        calls.push(args[args.indexOf("/opt/fullbeam/supervisor.mjs") + 1]!);
        now = 2000;
        return { exitCode: 0, stdout: '{"ok":true}' };
      },
    });
    try {
      await expect(
        executor.putBundle(
          {
            id: "deadline",
            role: "generation",
            projectId: "gen",
            branch: branchName("deadline"),
          },
          { files: [file("src/index.ts")] },
        ),
      ).rejects.toThrow(/deadline/i);
      expect(calls).toEqual(["upload-begin"]);
    } finally {
      clock.mockRestore();
    }
  });
  it("cleans up a recorded allocation even when setup expires before identity verification", async () => {
    const { RemoteController } = await import("../src/product/remote.js");
    const { EvidenceStore } = await import("../src/core/store.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-setup-deadline-"));
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: string[] = [];
    let exists = false;
    const controller = new RemoteController(
      {
        instacloudToken: "test",
        orgId: "org",
        openaiKey: "test",
        model: "test",
      } as any,
      {
        projects: { generation: "gen", verification: "verify" },
        images: {
          generation: "r@sha256:" + "a".repeat(64),
          verification: "r@sha256:" + "a".repeat(64),
        },
        region: "ams",
      } as any,
      new EvidenceStore(dir),
      "deadline-test",
    );
    controller.executor.options.transport = async (args) => {
      calls.push(args.slice(0, 2).join(" "));
      if (args[0] === "branch" && args[1] === "create") {
        exists = true;
        now += 600_000;
        return { branch: { id: "allocated", name: args[2] } };
      }
      if (args[0] === "branch" && args[1] === "list")
        return exists ? [{ name: branchName("deadline") }] : [];
      if (args[0] === "branch" && args[1] === "delete") {
        exists = false;
        return { ok: true };
      }
      throw new Error("Unexpected RPC after deadline");
    };
    try {
      await controller.initialize();
      await expect(
        controller.execute("deadline", [], {
          role: "generation",
          timeoutSeconds: 240,
          model: "test",
          prompt: "test",
        }),
      ).rejects.toThrow(/deadline/i);
      expect(calls).toEqual([
        "branch create",
        "branch list",
        "branch delete",
        "branch list",
      ]);
      expect(controller.journal.pending()).toEqual([]);
      expect(controller.journal.snapshot().map((e) => e.kind)).toEqual([
        "INTENT",
        "ALLOCATED",
        "DELETED",
      ]);
    } finally {
      clock.mockRestore();
      await controller.executor.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("journals deterministic intent before allocation and allocation before work", async () => {
    const sequence: string[] = [];
    const ready = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response('{"service":"fullbeam-runtime","ready":true}'),
      );
    const executor = new InstacloudExecutor({
      apiKey: "test-provider-key",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async (args) => {
        if (args[0] === "service")
          return [
            {
              name: "runtime",
              type: "compute",
              image: "registry/test@sha256:" + "a".repeat(64),
              always_on: true,
            },
          ];
        if (args[0] === "branch" && args[1] === "create") {
          sequence.push("create");
          return { branch: { id: "actual", name: args[2] } };
        }
        if (args[0] === "compute" && args[1] === "start")
          return {
            service: {
              name: "runtime",
              image: "registry/test@sha256:" + "a".repeat(64),
              domain: "runtime.example.test",
            },
          };
        throw new Error("Unexpected transport");
      },
      runtimeImages: {
        generation: "registry/test@sha256:" + "a".repeat(64),
        verification: "registry/test@sha256:" + "a".repeat(64),
      },
      onEnvironmentIntent: async () => {
        sequence.push("intent");
      },
      onEnvironmentAllocated: async () => {
        sequence.push("allocated");
      },
    });
    try {
      const env = await executor.createAttemptEnvironment({
        id: "run one / attempt A",
        role: "generation",
      });
      expect(sequence).toEqual(["intent", "create", "allocated"]);
      expect(env.branch).toBe(branchName("run one / attempt A"));
      expect(env.projectId).toBe("gen");
    } finally {
      ready.mockRestore();
    }
  });
  it("requires durable registration hooks before allocating billable resources", async () => {
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async () => {
        throw new Error("must not allocate");
      },
    });
    await expect(
      executor.createAttemptEnvironment({ id: "a", role: "generation" }),
    ).rejects.toThrow(/journal|registration/);
  });
  it("refuses unrelated cleanup and confirms actual absence", async () => {
    const calls: string[][] = [];
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async (args) => {
        calls.push(args);
        return args[1] === "list" ? [] : { ok: true };
      },
    });
    await expect(
      executor.destroy({
        id: "x",
        role: "generation",
        projectId: "gen",
        branch: "main",
      }),
    ).rejects.toThrow(/Fullbeam/);
    await executor.destroy({
      id: "x",
      role: "generation",
      projectId: "gen",
      branch: branchName("x"),
    });
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["branch", "list"]]);
  });
  it("does not call deletion successful while provider lists resource", async () => {
    const branch = branchName("x");
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async (args) =>
        args[1] === "list" ? [{ name: branch }] : { ok: true },
    });
    await expect(
      executor.destroy({
        id: "x",
        role: "generation",
        projectId: "gen",
        branch,
      }),
    ).rejects.toThrow(/still exists/);
  });
});
describe("trusted runtime boundaries", () => {
  const runtime = () => import("../runtime/supervisor.mjs" as string);
  it("captures new files and flags protected edits/deletions and new executable paths", async () => {
    const { detectViolations } = await runtime();
    const before = [file("src/old.ts"), file("package.json")];
    const after = [
      file("src/new.ts"),
      file("package.json", "tampered"),
      file("tests/fake.ts"),
    ];
    expect(detectViolations(before, after, ["src/"], ["package.json"])).toEqual(
      ["package.json", "tests/fake.ts"],
    );
  });
  it("rejects model proxy endpoint escapes, model changes, built-in web tools, and expired tokens", async () => {
    const { validateProxyRequest } = await runtime();
    const policy = {
      token: "attempt-token",
      model: "explicit-test-model",
      expiresAt: Date.now() + 1000,
    };
    expect(
      validateProxyRequest(
        "POST",
        "/v1/responses",
        "Bearer attempt-token",
        { model: policy.model },
        policy,
      ),
    ).toBe(true);
    for (const [method, path, auth, body, p] of [
      [
        "GET",
        "/v1/responses",
        "Bearer attempt-token",
        { model: policy.model },
        policy,
      ],
      [
        "POST",
        "/v1/files",
        "Bearer attempt-token",
        { model: policy.model },
        policy,
      ],
      [
        "POST",
        "/v1/responses",
        "Bearer wrong",
        { model: policy.model },
        policy,
      ],
      [
        "POST",
        "/v1/responses",
        "Bearer attempt-token",
        { model: "other" },
        policy,
      ],
      [
        "POST",
        "/v1/responses",
        "Bearer attempt-token",
        { model: policy.model, tools: [{ type: "web_search" }] },
        policy,
      ],
      [
        "POST",
        "/v1/responses",
        "Bearer attempt-token",
        { model: policy.model },
        { ...policy, expiresAt: 0 },
      ],
    ])
      expect(() => validateProxyRequest(method, path, auth, body, p)).toThrow();
  });
  it("rejects symlink output instead of following it into protected files", async () => {
    const { snapshot } = await runtime();
    const { mkdtemp, writeFile, symlink, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-snapshot-test-"));
    try {
      await writeFile(join(dir, "source"), "source");
      await symlink("/etc/passwd", join(dir, "leak"));
      const result = await snapshot(dir);
      expect(result.violations).toContain("leak");
      expect(result.files.map((f: any) => f.path)).toEqual(["source"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("immutable runtime identity", () => {
  it.each([
    [undefined, true, ""],
    [false, true, ""],
    ["true", true, ""],
    [true, true, ""],
    [
      true,
      false,
      "bwrap: No permissions to create a new namespace; insta_synthetic",
    ],
  ])(
    "requires native config and sandbox evidence (%s, %s) before bundle or model execution",
    async (nativeConfigVerified, nativeSandbox, sandboxError) => {
      const image = "registry/runtime@sha256:" + "a".repeat(64);
      const branches = new Set<string>();
      const probes: string[] = [];
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, options) => {
          if (String(_url) === "https://runtime.example.test")
            return new Response('{"service":"fullbeam-runtime","ready":true}');
          const request = JSON.parse(String(options?.body));
          if (request.id === undefined)
            return new Response(null, { status: 204 });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "tools/list"
                  ? {
                      tools: ["project", "branch", "deploy", "exec"].map(
                        (name) => ({ name: `insta_${name}` }),
                      ),
                    }
                  : {},
            }),
            { headers: { "content-type": "application/json" } },
          );
        });
      const executor = new InstacloudExecutor({
        apiKey: "insta_synthetic",
        orgId: "org",
        generationProjectId: "gen",
        verifierProjectId: "verify",
        runtimeImages: { generation: image, verification: image },
        onEnvironmentIntent: async () => {},
        onEnvironmentAllocated: async () => {},
        transport: async (args) => {
          if (args[0] === "--version") return "0.1.0";
          if (args[0] === "secrets")
            return { projectWide: [], branch: { unbound: [], services: [] } };
          if (args[0] === "service")
            return [
              { name: "runtime", type: "compute", image, always_on: true },
            ];
          if (args[0] === "compute" && args[1] === "start")
            return {
              service: {
                name: "runtime",
                image,
                domain: "runtime.example.test",
              },
            };
          if (args[0] === "branch") {
            if (args[1] === "create") {
              branches.add(args[2]!);
              return { branch: { id: args[2], name: args[2] } };
            }
            if (args[1] === "delete") {
              branches.delete(args[2]!);
              return { ok: true };
            }
            return [...branches].map((name) => ({ name }));
          }
          const verb = args[args.indexOf("/opt/fullbeam/supervisor.mjs") + 1];
          if (verb === "probe") {
            probes.push(args.at(-1)!);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                cleanTemplate: true,
                credentialIsolation: true,
                nativeSandbox,
                sandboxError,
                nativeConfigVerified,
              }),
            };
          }
          throw new Error("checkpoint after both configuration probes");
        },
      });
      try {
        const report = await executor.preflight();
        expect(report.status).toBe("BLOCKED");
        if (nativeConfigVerified === true && nativeSandbox === true) {
          expect(probes).toEqual(["generation", "verification"]);
          expect(report.blockers[0]).toContain(
            "checkpoint after both configuration probes",
          );
        } else if (nativeConfigVerified !== true) {
          expect(probes).toEqual(["generation"]);
          expect(report.blockers[0]).toMatch(/native configuration/i);
        } else {
          expect(probes).toEqual(["generation"]);
          expect(report.blockers[0]).toContain(
            "mandatory native sandbox probe failed",
          );
          expect(report.blockers[0]).toContain(
            "No permissions to create a new namespace",
          );
          expect(report.blockers[0]).toContain("[REDACTED]");
          expect(report.blockers[0]).not.toContain("insta_synthetic");
        }
        expect(branches.size).toBe(0);
      } finally {
        provider.mockRestore();
      }
    },
  );
  it("accepts a newly deployed template only after its public endpoint confirms runtime readiness", async () => {
    const image = "registry/runtime@sha256:" + "a".repeat(64);
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ service: "fullbeam-runtime", ready: true }),
            { status: 200 },
          ),
      );
    const executor = new InstacloudExecutor({
      apiKey: "insta_synthetic",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async (args) => {
        if (args[0] === "secrets")
          return { projectWide: [], branch: { unbound: [], services: [] } };
        if (args[0] === "service") return args[1] === "list" ? [] : {};
        if (args[0] === "compute") return { service: { always_on: true } };
        if (args[0] === "deploy")
          return { image, url: "https://runtime.example.test" };
        throw new Error("Unexpected command");
      },
    });
    try {
      expect(await executor.provisionTemplates("runtime")).toEqual({
        generation: image,
        verification: image,
      });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      probe.mockRestore();
    }
  });
  it("refuses an allocated child running a different image even after registration", async () => {
    const registered: string[] = [];
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      runtimeImages: {
        generation: "r@sha256:" + "a".repeat(64),
        verification: "r@sha256:" + "b".repeat(64),
      },
      onEnvironmentIntent: async () => {},
      onEnvironmentAllocated: async (e) => {
        registered.push(e.branch);
      },
      transport: async (args) =>
        args[0] === "branch"
          ? { branch: { id: "real-test-id", name: args[2] } }
          : [
              {
                name: "runtime",
                type: "compute",
                image: "r@sha256:" + "c".repeat(64),
                always_on: true,
              },
            ],
    });
    await expect(
      executor.createAttemptEnvironment({
        id: "test-image",
        role: "generation",
      }),
    ).rejects.toThrow(/image/);
    expect(registered).toHaveLength(1);
  });
  it("compiler outputs are explicitly excluded from submitted source", async () => {
    const { snapshot } = await import("../runtime/supervisor.mjs" as string);
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-build-output-"));
    try {
      await mkdir(join(dir, "dist"));
      await writeFile(join(dir, "dist/output.js"), "compiled");
      const report = await snapshot(dir);
      expect(report.files).toEqual([]);
      expect(report.excludedPaths).toContain("dist/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("frozen native harness execution", () => {
  it("rejects controller overrides that would mask a changed candidate model or reasoning effort", async () => {
    const { validateNativeConfig } = await import(
      "../runtime/supervisor.mjs" as string
    );
    const config =
      'model = "candidate-model"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n';
    expect(() =>
      validateNativeConfig(config, {
        model: "baseline-model",
        reasoningEffort: "high",
      }),
    ).toThrow(/model/);
    expect(() =>
      validateNativeConfig(config, {
        model: "candidate-model",
        reasoningEffort: "medium",
      }),
    ).toThrow(/reasoning/);
    expect(
      validateNativeConfig(config, {
        model: "candidate-model",
        reasoningEffort: "high",
      }).model,
    ).toBe("candidate-model");
    expect(() =>
      validateNativeConfig(config + "mcp_servers = {}\n", {
        model: "candidate-model",
        reasoningEffort: "high",
      }),
    ).toThrow(/unsupported/);
  });
  it("reuses an already deployed digest-addressed template without deployment mutations", async () => {
    let deploys = 0;
    const image = "r@sha256:" + "a".repeat(64);
    const executor = new InstacloudExecutor({
      apiKey: "test",
      orgId: "org",
      generationProjectId: "gen",
      verifierProjectId: "verify",
      transport: async (args) => {
        if (args[0] === "secrets")
          return { projectWide: [], branch: { unbound: [], services: [] } };
        if (args[0] === "service")
          return [{ name: "runtime", type: "compute", image, always_on: true }];
        deploys++;
        throw new Error("must not mutate immutable template");
      },
    });
    expect(await executor.provisionTemplates("runtime")).toEqual({
      generation: image,
      verification: image,
    });
    expect(deploys).toBe(0);
  });
});
it("allows native Codex client-side namespaces without admitting nested hosted tools", async () => {
  const { validateProxyRequest } = await import(
    "../runtime/supervisor.mjs" as string
  );
  const policy = {
    token: "attempt",
    model: "test",
    expiresAt: Date.now() + 1000,
  };
  const body = {
    model: "test",
    tools: [
      {
        type: "namespace",
        name: "functions",
        tools: [{ type: "function", name: "shell_command", parameters: {} }],
      },
      { type: "tool_search", execution: "client" },
    ],
  };
  expect(
    validateProxyRequest(
      "POST",
      "/v1/responses",
      "Bearer attempt",
      body,
      policy,
    ),
  ).toBe(true);
  expect(() =>
    validateProxyRequest(
      "POST",
      "/v1/responses",
      "Bearer attempt",
      {
        model: "test",
        tools: [
          { type: "namespace", name: "bad", tools: [{ type: "web_search" }] },
        ],
      },
      policy,
    ),
  ).toThrow();
});
describe("authoritative capture of failures", () => {
  it("attributes interrupted verification only with application exit or deadline evidence", async () => {
    const { verificationFailureKind } = await import(
      "../runtime/supervisor.mjs" as string
    );
    expect(verificationFailureKind(1, false)).toBe("APPLICATION_EXIT");
    expect(verificationFailureKind(0, false)).toBe("APPLICATION_EXIT");
    expect(verificationFailureKind(null, true)).toBe("VERIFICATION_TIMEOUT");
    expect(verificationFailureKind(null, false)).toBeUndefined();
  });
  it("preserves valid source evidence for a native configuration failure", async () => {
    const { snapshot, captureResult } = await import(
      "../runtime/supervisor.mjs" as string
    );
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-config-failure-"));
    try {
      await writeFile(join(dir, "package.json"), "original");
      const before = await snapshot(dir);
      const result: any = {
        status: "CANDIDATE_CONFIG_ERROR",
        violations: [],
        integrityVerified: false,
      };
      await captureResult(
        result,
        before,
        { role: "generation", allowedWritePaths: ["src/"] },
        dir,
      );
      expect(result.status).toBe("CANDIDATE_CONFIG_ERROR");
      expect(result.integrityVerified).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.beforeManifest).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects application-side verifier workspace changes while excluding only fixed build output", async () => {
    const { snapshot, captureResult } = await import(
      "../runtime/supervisor.mjs" as string
    );
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-verifier-mutation-"));
    try {
      await writeFile(join(dir, "package.json"), "original");
      const before = await snapshot(dir);
      await writeFile(join(dir, "package.json"), "tampered");
      await mkdir(join(dir, "dist"));
      await writeFile(join(dir, "dist/server.js"), "built");
      const result: any = {
        status: "COMPLETED",
        violations: [],
        integrityVerified: false,
      };
      await captureResult(result, before, { role: "verification" }, dir);
      expect(result.status).toBe("POLICY_VIOLATION");
      expect(result.violations).toEqual(["package.json"]);
      expect(result.integrityVerified).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
