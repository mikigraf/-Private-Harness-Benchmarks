import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { setupDatabase } from "../src/product/database-setup.js";
import { EvidenceStore } from "../src/core/store.js";
import { digest } from "../src/core/integrity.js";
import type { Config } from "../src/core/config.js";

const databaseUrl =
  "postgresql://operator:private-password@db.example.test:5432/fullbeam?sslmode=require";
const securedDatabaseUrl =
  "postgresql://operator:private-password@db.example.test:5432/fullbeam?sslmode=verify-full";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fullbeam-db-setup-"));
  const envPath = join(directory, ".env");
  const text =
    "# Keep this comment\nOPENAI_API_KEY=unrelated-key\nCUSTOM_VALUE='keep # exact bytes'\n";
  await writeFile(envPath, text, { mode: 0o644 });
  const config = {
    githubToken: "github-secret",
    instacloudToken: "insta-secret",
    openaiKey: "openai-secret",
    orgId: "organization",
    region: "us-east",
    repository: "owner/demo",
    demoRepository: "owner/demo",
    stateDir: join(directory, "state"),
    model: "model",
    reasoningEffort: "medium",
    rates: null,
    maxCost: null,
  } as Config;
  return { directory, envPath, text, config };
}

describe("database bootstrap", () => {
  it("validates an explicitly configured connection without provisioning or changing unrelated settings", async () => {
    const f = await fixture();
    const run = vi.fn(async () => {
      throw new Error("Unexpected cloud command");
    });
    const verify = vi.fn(async (url: string) => {
      if (url !== databaseUrl) throw new Error("Wrong connection supplied");
      return { serverVersion: "16.15" };
    });
    try {
      const result = await setupDatabase(
        { ...f.config, databaseUrl },
        { envPath: f.envPath, run, verify },
      );
      expect(result.databaseUrl).toBe(databaseUrl);
      expect(verify).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(f.envPath, "utf8")).toBe(f.text);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("provisions one named database on the explicit application project and saves only its configuration securely", async () => {
    const f = await fixture();
    let services: any[] = [];
    const additions: string[][] = [];
    const calls: {
      args: string[];
      context?: { projectId?: string; branch?: string };
    }[] = [];
    const run = async (
      args: string[],
      context?: { projectId?: string; branch?: string },
    ) => {
      calls.push({ args, context });
      if (args[0] === "project" && args[1] === "list")
        return [
          {
            id: "app-project",
            name: "private-benchmarks",
            org_id: "organization",
          },
        ];
      expect(context).toEqual({ projectId: "app-project", branch: "main" });
      if (args[0] === "service" && args[1] === "list") return services;
      if (args[0] === "service" && args[1] === "add") {
        additions.push(args);
        services = [
          { id: "database-service", type: "postgres", name: "fullbeam-db" },
        ];
        return services[0];
      }
      if (args[0] === "postgres" && args[1] === "url")
        return { service: "fullbeam-db", branch: "main", url: databaseUrl };
      throw new Error("Unexpected command");
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const cfg = { ...f.config, instacloudProjectId: "app-project" };
      const dependencies = {
        envPath: f.envPath,
        run,
        verify: async () => ({ serverVersion: "16.15" }),
      };
      const result = await setupDatabase(cfg, dependencies);
      await setupDatabase(cfg, dependencies);
      expect(additions).toHaveLength(1);
      expect(result.databaseUrl).toBe(securedDatabaseUrl);
      expect(result.instacloudProjectId).toBe("app-project");
      const contents = await readFile(f.envPath, "utf8");
      expect(contents).toContain(f.text);
      expect(contents.match(/^DATABASE_URL=/gm)).toHaveLength(1);
      expect(contents.match(/^FULLBEAM_INSTACLOUD_PROJECT_ID=/gm)).toHaveLength(
        1,
      );
      expect(parse(contents)).toEqual({
        OPENAI_API_KEY: "unrelated-key",
        CUSTOM_VALUE: "keep # exact bytes",
        DATABASE_URL: securedDatabaseUrl,
        FULLBEAM_INSTACLOUD_PROJECT_ID: "app-project",
      });
      expect((await stat(f.envPath)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-password");
      const receipt = await new EvidenceStore(f.config.stateDir).state<any>(
        "database.json",
      );
      expect(receipt).toMatchObject({
        project_id: "app-project",
        service_id: "database-service",
        connection_verified: true,
      });
      expect(JSON.stringify(receipt)).not.toContain("private-password");
    } finally {
      log.mockRestore();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("refuses to add Postgres to either frozen runtime template", async () => {
    const f = await fixture();
    const store = new EvidenceStore(f.config.stateDir);
    await store.saveState("template-projects.json", {
      generation: "generation",
      verification: "verification",
    });
    const run = vi.fn(async () => []);
    try {
      await expect(
        setupDatabase(
          { ...f.config, instacloudProjectId: "generation" },
          { envPath: f.envPath, run },
        ),
      ).rejects.toThrow(/template/i);
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(f.envPath, "utf8")).toBe(f.text);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("rejects a renamed runtime project even when no local template lock is available", async () => {
    const f = await fixture();
    const mutations: string[][] = [];
    const run = async (args: string[]) => {
      if (args[0] === "project" && args[1] === "list")
        return [
          {
            id: "renamed-template",
            name: "renamed-by-owner",
            org_id: "organization",
          },
        ];
      if (args[0] === "service" && args[1] === "list")
        return [{ id: "compute", type: "compute", name: "runtime" }];
      mutations.push(args);
      throw new Error("An unrelated runtime must not be modified");
    };
    try {
      await expect(
        setupDatabase(
          { ...f.config, instacloudProjectId: "renamed-template" },
          { envPath: f.envPath, run },
        ),
      ).rejects.toThrow(/template/i);
      expect(mutations).toEqual([]);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("recovers its recorded application project after a lost create response without duplicating it", async () => {
    const f = await fixture();
    let projects: any[] = [];
    let creates = 0;
    const run = async (args: string[]) => {
      if (args[0] === "project" && args[1] === "list") return projects;
      if (args[0] === "project" && args[1] === "create") {
        creates++;
        projects = [
          { id: "recovered-app", name: args[2], org_id: "organization" },
        ];
        throw new Error("Lost create response");
      }
      if (args[0] === "service" && args[1] === "list")
        return [{ id: "existing-db", type: "postgres", name: "fullbeam-db" }];
      if (args[0] === "postgres" && args[1] === "url")
        return { service: "fullbeam-db", branch: "main", url: databaseUrl };
      throw new Error("Unexpected command");
    };
    try {
      const deps = {
        envPath: f.envPath,
        run,
        verify: async () => ({ serverVersion: "16.15" }),
      };
      await expect(setupDatabase(f.config, deps)).rejects.toThrow(
        "Lost create response",
      );
      const result = await setupDatabase(f.config, deps);
      expect(result.instacloudProjectId).toBe("recovered-app");
      expect(creates).toBe(1);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("redacts both the DSN and password from failed connection diagnostics", async () => {
    const f = await fixture();
    try {
      const operation = setupDatabase(
        { ...f.config, databaseUrl },
        {
          envPath: f.envPath,
          verify: async () => {
            throw new Error(
              `Cannot connect ${databaseUrl}; password private-password`,
            );
          },
        },
      );
      await expect(operation).rejects.toThrow(
        "Cannot connect [REDACTED]; password [REDACTED]",
      );
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("does not adopt an unrecorded deterministic project merely because its name matches", async () => {
    const f = await fixture();
    const name = `fb-app-${digest({ org: f.config.orgId, repo: f.config.repository }).slice(0, 16)}`;
    try {
      await expect(
        setupDatabase(f.config, {
          envPath: f.envPath,
          run: async () => [{ id: "unowned", name, org_id: "organization" }],
        }),
      ).rejects.toThrow(/allocation intent/i);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
