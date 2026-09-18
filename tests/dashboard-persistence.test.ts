import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostgresDashboardPersistence } from "../src/dashboard/persistence.js";

class FakePool extends EventEmitter {
  records = new Map<
    string,
    { value: unknown; value_sha256: string; record_key: string }
  >();
  locks = new Set<string>();
  clients: (EventEmitter & {
    query: FakePool["query"];
    release: () => void;
  })[] = [];
  async query(sql: string, args: any[] = []): Promise<any> {
    const key = `${args[0]}:${args[1]}`;
    if (sql.includes("pg_try_advisory_lock")) {
      const acquired = !this.locks.has(key);
      if (acquired) this.locks.add(key);
      return { rows: [{ acquired }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      this.locks.delete(key);
      return { rows: [{}], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO fullbeam_dashboard.records")) {
      const old = this.records.get(key);
      if (old && sql.includes("DO NOTHING")) return { rows: [], rowCount: 0 };
      this.records.set(key, {
        value: JSON.parse(args[2]),
        value_sha256: args[3],
        record_key: args[1],
      });
      return { rows: [{ value_sha256: args[3] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT record_key"))
      return {
        rows: [...this.records.entries()]
          .filter(
            ([k, v]) =>
              k.startsWith(`${args[0]}:`) && v.record_key.startsWith(args[1]),
          )
          .map(([, v]) => v),
      };
    if (sql.startsWith("SELECT value")) {
      const row = this.records.get(key);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
  async connect() {
    const client = Object.assign(new EventEmitter(), {
      query: this.query.bind(this),
      release: () => {},
    });
    this.clients.push(client);
    return client;
  }
  async end() {}
}

describe("authoritative Postgres dashboard persistence", () => {
  it("refuses initial migration while a legacy worker is alive but accepts a verified dead lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-pg-legacy-"));
    const pool = new FakePool();
    const first = new PostgresDashboardPersistence(
      "postgres://unused",
      "owner/repo",
      root,
      pool as any,
    );
    try {
      await writeFile(
        join(root, "dashboard-worker.json"),
        JSON.stringify({ pid: process.pid }),
      );
      await expect(first.open()).rejects.toThrow("Stop the running legacy");
      expect(pool.records.has("owner/repo:migration/local-files-v1")).toBe(
        false,
      );
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("dead"), { code: "ESRCH" });
      });
      const second = new PostgresDashboardPersistence(
        "postgres://unused",
        "owner/repo",
        root,
        pool as any,
      );
      try {
        await second.open();
      } finally {
        kill.mockRestore();
        await second.close();
      }
      const restarted = new PostgresDashboardPersistence(
        "postgres://unused",
        "owner/repo",
        root,
        pool as any,
      );
      // The original live PID remains in the file; after the import marker it is irrelevant.
      await expect(restarted.open()).resolves.toBeUndefined();
      await restarted.close();
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("imports private local records exactly once and preserves their original JSON/hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-pg-import-"));
    const pool = new FakePool();
    try {
      await mkdir(join(root, "dashboard/completed"), { recursive: true });
      const queue = {
        repository: "owner/repo",
        jobs: [
          { jobId: "already-recorded", intent: { trigger: "unique-trigger" } },
        ],
      };
      const archived = {
        detail_digest: "original-digest",
        detail: { report: { report_hash: "original-report-hash" } },
      };
      await writeFile(join(root, "dashboard-jobs.json"), JSON.stringify(queue));
      await writeFile(
        join(root, "dashboard/completed/42.json"),
        JSON.stringify(archived),
      );
      const first = new PostgresDashboardPersistence(
        "postgres://unused",
        "owner/repo",
        root,
        pool as any,
      );
      expect(await first.state("dashboard-jobs.json")).toEqual(queue);
      expect(await first.state("dashboard/completed/42.json")).toEqual(
        archived,
      );
      await first.acquireWorker();
      await first
        .scope()
        .saveState("dashboard-jobs.json", { ...queue, jobs: [] });
      await writeFile(
        join(root, "dashboard-jobs.json"),
        JSON.stringify({ jobs: ["stale local state"] }),
      );
      const restarted = new PostgresDashboardPersistence(
        "postgres://unused",
        "owner/repo",
        root,
        pool as any,
      );
      expect(await restarted.state("dashboard-jobs.json")).toEqual({
        ...queue,
        jobs: [],
      });
      expect(await restarted.list("dashboard/completed/")).toEqual([
        "dashboard/completed/42.json",
      ]);
      await first.close();
      await restarted.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects changed records, immutable replacement, and concurrent/lost worker locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-pg-lock-"));
    const pool = new FakePool();
    const first = new PostgresDashboardPersistence(
      "postgres://unused",
      "owner/repo",
      root,
      pool as any,
    );
    const second = new PostgresDashboardPersistence(
      "postgres://unused",
      "owner/repo",
      root,
      pool as any,
    );
    try {
      await first.scope("dashboard").immutable("evidence.json", { actual: 1 });
      await expect(
        first.scope("dashboard").immutable("evidence.json", { actual: 2 }),
      ).rejects.toThrow("immutable");
      pool.records.get("owner/repo:dashboard/evidence.json")!.value = {
        actual: 999,
      };
      await expect(first.state("dashboard/evidence.json")).rejects.toThrow(
        "integrity",
      );
      await first.acquireWorker();
      await expect(second.acquireWorker()).rejects.toThrow("already holds");
      pool.clients[1]!.emit("error", new Error("connection lost"));
      await expect(first.assertWorker()).rejects.toThrow("unavailable");
      await expect(
        first
          .scope()
          .saveState("dashboard-jobs.json", { jobs: ["must-not-write"] }),
      ).rejects.toThrow("unavailable");
      expect(pool.records.has("owner/repo:dashboard-jobs.json")).toBe(false);
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not read local fallback records when Postgres is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-pg-down-"));
    try {
      await writeFile(
        join(root, "dashboard-jobs.json"),
        JSON.stringify({ local: true }),
      );
      const pool = Object.assign(new EventEmitter(), {
        connect: async () => {
          throw new Error("database unavailable");
        },
        end: async () => {},
      });
      const persistence = new PostgresDashboardPersistence(
        "postgres://unused",
        "owner/repo",
        root,
        pool as any,
      );
      await expect(persistence.state("dashboard-jobs.json")).rejects.toThrow(
        "database unavailable",
      );
      await persistence.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never moves a failed mutable write from the worker session to a healthy pool connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-pg-fence-"));
    const pool = new FakePool();
    const persistence = new PostgresDashboardPersistence(
      "postgres://unused",
      "owner/repo",
      root,
      pool as any,
    );
    try {
      await persistence.acquireWorker();
      const worker = pool.clients.at(-1)!;
      const query = worker.query;
      worker.query = async (sql: string, args: any[] = []) => {
        if (sql.startsWith("INSERT INTO fullbeam_dashboard.records"))
          throw new Error("worker socket disconnected during write");
        return query(sql, args);
      };
      await expect(
        persistence.scope().saveState("dashboard-jobs.json", { jobs: ["new"] }),
      ).rejects.toThrow("worker write failed");
      expect(pool.records.has("owner/repo:dashboard-jobs.json")).toBe(false);
      await expect(persistence.assertWorker()).rejects.toThrow("unavailable");
    } finally {
      await persistence.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
