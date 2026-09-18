import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { EvidenceStore } from "../src/core/store.js";
import { RemoteController } from "../src/product/remote.js";
import type { EnvironmentRef } from "../src/execution/instacloud.js";

it("shares durable ordering while worker cleanup cannot delete a peer's active environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fullbeam-workers-"));
  const root = new RemoteController(
    {
      instacloudToken: "test",
      orgId: "org",
      openaiKey: "test",
      model: "model",
    } as any,
    {
      projects: { generation: "gen", verification: "verify" },
      images: {},
      region: "us-east",
    } as any,
    new EvidenceStore(dir),
    "workers-test",
  );
  await root.initialize();
  const first = root.fork(),
    second = root.fork();
  expect(first.journal).toBe(root.journal);
  expect(second.executor).not.toBe(first.executor);
  let unblock!: () => void, allocated!: () => void;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    allocated = resolve;
  });
  const deleted: string[] = [];
  function wire(worker: RemoteController, wait: boolean) {
    vi.spyOn(worker.executor, "createAttemptEnvironment").mockImplementation(
      async ({ id, role }) => {
        const env: EnvironmentRef = {
          id,
          role,
          projectId: "gen",
          branch: `fullbeam-${id}`,
          providerId: id,
        };
        await worker.journal.append("INTENT", env);
        await worker.journal.append("ALLOCATED", env);
        if (wait) {
          allocated();
          await held;
        }
        throw new Error("deliberate setup failure");
      },
    );
    vi.spyOn(worker.executor, "destroy").mockImplementation(async (env) => {
      deleted.push(env.id);
    });
  }
  wire(first, false);
  wire(second, true);
  vi.spyOn(root.executor, "destroy").mockImplementation(async (env) => {
    deleted.push(env.id);
  });
  const secondRun = second.execute("second", [], {
    role: "generation",
    timeoutSeconds: 240,
  });
  // Install rejection handling before either asynchronous setup may fail.
  const secondFailure = expect(secondRun).rejects.toThrow(
    "deliberate setup failure",
  );
  try {
    await ready;
    await expect(
      first.execute("first", [], { role: "generation", timeoutSeconds: 240 }),
    ).rejects.toThrow("deliberate setup failure");
    expect(await first.cleanup()).toBe(true);
    await first.close();
    expect(deleted).toEqual(["first"]);
    expect(root.journal.pending().map((env) => env.id)).toEqual(["second"]);
    unblock();
    await secondFailure;
    await second.close();
    expect(deleted).toEqual(["first", "second"]);
    expect(root.journal.pending()).toEqual([]);
    const events = root.journal.snapshot();
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    await root.journal.load();
    expect(root.journal.snapshot()).toEqual(events);
    expect(await root.cleanup()).toBe(true);
  } finally {
    unblock();
    await Promise.allSettled([first.close(), second.close(), root.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
