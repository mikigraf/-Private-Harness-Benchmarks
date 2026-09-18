import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  materializeFixture,
  mutantFiles,
  expectedCheckIds,
  referenceFiles,
  seedTasks,
  verifyRelayDesk,
  type FileEntry,
  type RelayDeskStage,
} from "../src/benchmark/relaydesk.js";

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

afterAll(async () => {
  for (const child of childProcesses) child.kill("SIGTERM");
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RelayDesk fixture manifests", () => {
  it("publishes the three stable seed tasks without solution-bearing text", () => {
    expect(
      seedTasks.map(({ id, risk, component }) => ({ id, risk, component })),
    ).toEqual([
      {
        id: "tenant-event-read",
        risk: "CRITICAL",
        component: "tenant isolation",
      },
      {
        id: "tenant-idempotency",
        risk: "CRITICAL",
        component: "data integrity",
      },
      {
        id: "stable-event-pagination",
        risk: "STANDARD",
        component: "pagination",
      },
    ]);
    for (const task of seedTasks) {
      expect(task.title.length).toBeGreaterThan(5);
      expect(task.body).not.toMatch(
        /mutant|reference (?:fix|patch)|seed defect/i,
      );
    }
    expect(expectedCheckIds("tenant-event-read")).toEqual([
      "tenant-read.foreign-is-404",
      "tenant-read.foreign-body-redacted",
      "tenant-read.owner-is-200",
      "tenant-read.unknown-is-404",
      "tenant-read.independent-owner",
      "common.health",
    ]);
  });

  it("materializes deterministic, self-verifying generation bundles with the native harness", async () => {
    const first = await materializeFixture(0);
    const second = await materializeFixture(0);
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.path)).toEqual(
      [...first.map((entry) => entry.path)].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(first.some((entry) => entry.path === "package-lock.json")).toBe(
      true,
    );
    expect(
      first.some(
        (entry) => entry.path === ".agents/skills/tenant-safety/SKILL.md",
      ),
    ).toBe(true);
    expect(first.some((entry) => entry.path === ".codex/config.toml")).toBe(
      true,
    );
    expect(first.every(validEntry)).toBe(true);
    expect(
      first.every(
        (entry) =>
          !entry.path.includes("controller") &&
          !entry.path.includes("mutant") &&
          !entry.path.includes("reference"),
      ),
    ).toBe(true);
  });

  it("exposes source-only reference and mutant manifests at each task boundary", async () => {
    const taskStages: Array<[string, RelayDeskStage, RelayDeskStage]> = [
      ["tenant-event-read", 0, 1],
      ["tenant-idempotency", 1, 2],
      ["stable-event-pagination", 2, 3],
    ];
    for (const [taskId, baseStage, fixedStage] of taskStages) {
      const base = sourceOnly(await materializeFixture(baseStage));
      const fixed = sourceOnly(await materializeFixture(fixedStage));
      const reference = await referenceFiles(taskId);
      const mutant = await mutantFiles(taskId);
      expect(reference).toEqual(fixed);
      expect(reference).not.toEqual(base);
      expect(reference.every((entry) => entry.path.startsWith("src/"))).toBe(
        true,
      );
      expect(mutant.every((entry) => entry.path.startsWith("src/"))).toBe(true);
      expect(mutant).not.toEqual(reference);
    }
  });

  it("adds ordinary regression tests only after their corresponding fix", async () => {
    const paths = await Promise.all(
      ([0, 1, 2, 3] as const).map(async (stage) =>
        (await materializeFixture(stage)).map((entry) => entry.path),
      ),
    );
    expect(paths[0]).toContain("tests/public/health.test.ts");
    expect(paths[0]).not.toContain("tests/public/tenant-event-read.test.ts");
    expect(paths[1]).toContain("tests/public/tenant-event-read.test.ts");
    expect(paths[1]).not.toContain("tests/public/tenant-idempotency.test.ts");
    expect(paths[2]).toContain("tests/public/tenant-idempotency.test.ts");
    expect(paths[2]).not.toContain(
      "tests/public/stable-event-pagination.test.ts",
    );
    expect(paths[3]).toContain("tests/public/stable-event-pagination.test.ts");
  });
});

describe.sequential("RelayDesk HTTP controls", () => {
  it("reports candidate transport failures as expected failed checks", async () => {
    const port = await freePort();
    const results = await verifyRelayDesk(
      "tenant-event-read",
      `http://127.0.0.1:${port}`,
    );
    expect(results.map((result) => result.id)).toEqual(
      expectedCheckIds("tenant-event-read"),
    );
    expect(results.every((result) => result.status === "FAIL")).toBe(true);
  });

  it("rejects each historical base and accepts its sequential reference", async () => {
    for (const [taskId, base, reference] of [
      ["tenant-event-read", 0, 1],
      ["tenant-idempotency", 1, 2],
      ["stable-event-pagination", 2, 3],
    ] as const) {
      const baseline = await startFixture(base);
      const baseResults = await verifyRelayDesk(taskId, baseline.url);
      expect(
        baseResults.some((result) => result.status === "FAIL"),
        JSON.stringify(baseResults, null, 2),
      ).toBe(true);
      const fixed = await startFixture(reference);
      const fixedResults = await verifyRelayDesk(taskId, fixed.url);
      expect(
        fixedResults.every((result) => result.status === "PASS"),
        JSON.stringify(fixedResults, null, 2),
      ).toBe(true);
    }
  }, 120_000);

  it("rejects the semantic mutant for every task", async () => {
    for (const task of seedTasks) {
      const baseStage = seedTasks.findIndex(
        ({ id }) => id === task.id,
      ) as RelayDeskStage;
      const fixture = await startFixture(baseStage, await mutantFiles(task.id));
      const results = await verifyRelayDesk(task.id, fixture.url);
      expect(
        results.some((result) => result.status === "FAIL"),
        JSON.stringify(results, null, 2),
      ).toBe(true);
    }
  }, 120_000);
});

function validEntry(entry: FileEntry): boolean {
  const bytes = Buffer.from(entry.content, "base64");
  return (
    entry.path.length > 0 &&
    bytes.byteLength === entry.size &&
    createHash("sha256").update(bytes).digest("hex") === entry.sha256 &&
    entry.mode === 0o100644
  );
}

function sourceOnly(entries: FileEntry[]): FileEntry[] {
  return entries.filter((entry) => entry.path.startsWith("src/"));
}

async function startFixture(
  stage: RelayDeskStage,
  sourceOverride?: FileEntry[],
): Promise<{ url: string }> {
  const directory = await mkdtemp(join(tmpdir(), `relaydesk-stage-${stage}-`));
  temporaryDirectories.push(directory);
  const entries = await materializeFixture(stage);
  const replacements = new Map(
    sourceOverride?.map((entry) => [entry.path, entry]),
  );
  for (const original of entries) {
    const entry = replacements?.get(original.path) ?? original;
    const destination = join(directory, entry.path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, Buffer.from(entry.content, "base64"), {
      mode: entry.mode & 0o777,
    });
  }

  // Offline control evidence: reuse the controller's already-installed dependency tree.
  const root = process.cwd();
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const build = spawn(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: directory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForExit(build, "fixture build");
  const publicTests = spawn(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "tests/public"],
    {
      cwd: directory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForExit(publicTests, "fixture public tests");

  const port = await freePort();
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: directory,
    env: {
      ...process.env,
      NODE_PATH: join(root, "node_modules"),
      PORT: String(port),
      RELAYDESK_FIXED_TIME: "2025-01-02T03:04:05.000Z",
      RELAYDESK_ID_PREFIX: "evt-test-",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcesses.push(child);
  await waitForHealth(`http://127.0.0.1:${port}`, child);
  return { url: `http://127.0.0.1:${port}` };
}

async function waitForExit(child: ChildProcess, label: string): Promise<void> {
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  if (code !== 0) throw new Error(`${label} failed (${code}): ${output}`);
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`fixture exited before health check (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fixture did not become healthy");
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("could not allocate test port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
