import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../src/core/store.js";
import {
  ResourceJournal,
  evidenceFiles,
  type JournalEvent,
} from "../src/core/checkpoints.js";
import { branchName } from "../src/execution/instacloud.js";
const env = {
  id: "synthetic-attempt",
  role: "generation" as const,
  projectId: "synthetic-project",
  branch: branchName("synthetic-attempt"),
};
describe("resource journal interruption recovery", () => {
  it("publishes concurrent evidence completely and archives immutable events without mutable indexes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-evidence-"));
    const store = new EvidenceStore(dir);
    try {
      const data = "a".repeat(1024 * 1024);
      const refs = await Promise.all(
        Array.from({ length: 8 }, () => store.put(data)),
      );
      expect(new Set(refs.map((ref) => ref.id)).size).toBe(1);
      expect((await store.read(refs[0]!)).toString()).toBe(data);
      const journal = new ResourceJournal(store, "synthetic-run");
      await journal.load();
      await journal.append("INTENT", env);
      await writeFile(join(dir, "objects", "pending.tmp"), "incomplete");
      const files = await evidenceFiles(dir);
      expect(files.some((file) => file.includes("journal-events"))).toBe(true);
      expect(files.some((file) => file.includes("/journals/"))).toBe(false);
      expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          store.immutable("comparison.json", { value: 1 }),
        ),
      );
      await expect(
        store.immutable("comparison.json", { value: 2 }),
      ).rejects.toThrow("immutable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reconciles an immutable event written before the mutable index was saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-journal-"));
    const store = new EvidenceStore(dir);
    const event: JournalEvent = {
      schema_version: 1,
      sequence: 0,
      at: "2026-09-18T00:00:00Z",
      kind: "INTENT",
      environment: env,
      run_id: "synthetic-run",
    };
    try {
      await store.immutable("journal-events/synthetic-run/0.json", event);
      await store.saveState("journals/synthetic-run.json", []);
      const journal = new ResourceJournal(store, "synthetic-run");
      await journal.load();
      expect(journal.pending()).toEqual([env]);
      await journal.append("ALLOCATED", env);
      expect(journal.snapshot().map((e) => e.sequence)).toEqual([0, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("retries a dropped checkpoint with the original event bytes and then permits the next transition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-journal-"));
    const store = new EvidenceStore(dir);
    const events: JournalEvent[] = [];
    let fail = true;
    const checkpoint = async (event: JournalEvent) => {
      events.push(structuredClone(event));
      if (fail) {
        fail = false;
        throw new Error("synthetic artifact outage");
      }
    };
    try {
      const journal = new ResourceJournal(store, "synthetic-run", checkpoint);
      await journal.load();
      await expect(journal.append("INTENT", env)).rejects.toThrow("outage");
      const resumed = new ResourceJournal(store, "synthetic-run", checkpoint);
      await resumed.load();
      await resumed.append("INTENT", env);
      await resumed.append("ALLOCATED", env);
      expect(events[0]).toEqual(events[1]);
      expect(resumed.snapshot().map((e) => e.kind)).toEqual([
        "INTENT",
        "ALLOCATED",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("serializes concurrent appends into distinct immutable sequence entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fullbeam-journal-"));
    const store = new EvidenceStore(dir);
    try {
      const journal = new ResourceJournal(store, "synthetic-run");
      await journal.load();
      await Promise.all([
        journal.append("INTENT", env),
        journal.append("INTENT", {
          ...env,
          id: "second",
          branch: branchName("second"),
        }),
      ]);
      expect(journal.snapshot().map((e) => e.sequence)).toEqual([0, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
