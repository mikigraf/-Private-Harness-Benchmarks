import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupRuntime } from "../src/product/runtime-setup.js";
import { EvidenceStore } from "../src/core/store.js";
import { RemoteController } from "../src/product/remote.js";
import { branchName } from "../src/execution/instacloud.js";
import type { Config } from "../src/core/config.js";
const config: Config = {
  githubToken: "synthetic",
  repository: "owned/test",
  demoRepository: "owned/test",
  instacloudToken: "synthetic",
  orgId: "test-org",
  region: "ams",
  openaiKey: "synthetic",
  model: "synthetic-model",
  reasoningEffort: "medium",
  stateDir: "/unused",
  rates: null,
  maxCost: null,
};
const images = {
  generation: "test@sha256:" + "a".repeat(64),
  verification: "test@sha256:" + "b".repeat(64),
};
const capability = {
  status: "READY" as const,
  checkedAt: "2026-09-18T00:00:00Z",
  region: "ams",
  observations: { syntheticTest: true },
  blockers: [],
};
const fakeExecutor = () => ({
  provisionTemplates: async () => images,
  preflight: async () => capability,
  destroy: async () => {},
  close: async () => {},
});
describe("immutable runtime setup", () => {
  it("persists a template creation intent then recovers the exact org/name after a dropped response without duplicate creation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-setup-"));
    const store = new EvidenceStore(dir);
    const projects: any[] = [];
    let lost = true,
      creates = 0;
    const run = async (args: string[]) => {
      if (args[0] === "login") return {};
      if (args[0] === "config" && args[1] === "regions")
        return [{ slug: "ams" }];
      if (args[1] === "list") return projects;
      if (args[1] === "create") {
        creates++;
        const project = {
          id: `project-${creates}`,
          name: args[2],
          org_id: "test-org",
        };
        projects.push(project);
        if (lost) {
          lost = false;
          throw new Error("response lost after allocation");
        }
        return { project };
      }
      throw new Error("Unexpected provider request");
    };
    try {
      await expect(
        setupRuntime(config, store, { run, executorFactory: fakeExecutor }),
      ).rejects.toThrow("response lost");
      const lock = await setupRuntime(config, store, {
        run,
        executorFactory: fakeExecutor,
      });
      expect(creates).toBe(2);
      expect(lock.projects).toEqual({
        generation: "project-1",
        verification: "project-2",
      });
      const reused = await setupRuntime(config, store, {
        run: async () => {
          throw new Error("must not redeploy");
        },
        executorFactory: () => {
          throw new Error("must not redeploy");
        },
      });
      expect(reused.application_digest).toBe(lock.application_digest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses ambiguous intent recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-setup-"));
    const store = new EvidenceStore(dir);
    let intended = "";
    const run = async (args: string[]) => {
      if (args[0] === "login") return {};
      if (args[0] === "config" && args[1] === "regions")
        return [{ slug: "ams" }];
      if (args[1] === "list")
        return intended
          ? [
              { id: "a", name: intended, org_id: "test-org" },
              { id: "b", name: intended, org_id: "test-org" },
            ]
          : [];
      if (args[1] === "create") {
        intended = args[2]!;
        throw new Error("lost");
      }
      throw new Error("Unexpected");
    };
    try {
      await expect(
        setupRuntime(config, store, { run, executorFactory: fakeExecutor }),
      ).rejects.toThrow("lost");
      await expect(
        setupRuntime(config, store, { run, executorFactory: fakeExecutor }),
      ).rejects.toThrow(/ambiguous/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects runtime reuse with changed source identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-setup-"));
    const store = new EvidenceStore(dir);
    try {
      await store.saveState("runtime.json", {
        schema_version: 1,
        images,
        capability,
        source_digest: "0".repeat(64),
        org_id: "test-org",
        repository: "owned/test",
        projects: { generation: "g", verification: "v" },
      });
      await expect(
        setupRuntime(config, store, {
          run: async () => {
            throw new Error("unexpected network");
          },
          executorFactory: fakeExecutor,
        }),
      ).rejects.toThrow(/source|stale/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("remote exceptional cleanup", () => {
  it("cleans journaled allocation when create fails before returning an environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-remote-"));
    const store = new EvidenceStore(dir);
    const runtime: any = {
      projects: { generation: "g", verification: "v" },
      images,
      capability,
      region: "ams",
    };
    const remote = new RemoteController(config, runtime, store, "test-run");
    await remote.initialize();
    const env = {
      id: "test-attempt",
      role: "generation" as const,
      projectId: "g",
      branch: branchName("test-attempt"),
    };
    let destroyed = false;
    remote.executor.createAttemptEnvironment = async () => {
      await remote.journal.append("INTENT", env);
      await remote.journal.append("ALLOCATED", env);
      throw new Error("image mismatch after allocation");
    };
    remote.executor.destroy = async () => {
      destroyed = true;
    };
    try {
      await expect(
        remote.execute("test-attempt", [], {
          role: "generation",
          timeoutSeconds: 1,
        }),
      ).rejects.toThrow("image mismatch");
      expect(destroyed).toBe(true);
      expect(remote.journal.pending()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
