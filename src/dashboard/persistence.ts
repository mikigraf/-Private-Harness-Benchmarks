import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { canonical, digest, normalizePath } from "../core/integrity.js";

export interface DashboardStore {
  state<T>(key: string): Promise<T | null>;
  saveState(key: string, value: unknown): Promise<void>;
  immutable(key: string, value: unknown): Promise<void>;
}
export class DashboardLockError extends Error {}

function advisoryKey(repository: string): [number, number] {
  const hash = createHash("sha256")
    .update(`fullbeam-dashboard-worker:${repository.toLowerCase()}`)
    .digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

/** Postgres is authoritative. Errors never fall back to local mutable state. */
export class PostgresDashboardPersistence {
  private pool: Pool;
  private ready?: Promise<void>;
  private worker?: PoolClient;
  private workerLost = false;
  private closing?: Promise<void>;
  readonly repository: string;
  constructor(
    databaseUrl: string,
    repository: string,
    private localStateDir: string,
    pool?: Pool,
  ) {
    this.repository = repository.toLowerCase();
    this.pool =
      pool ??
      new Pool({
        connectionString: databaseUrl,
        max: 3,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
        allowExitOnIdle: true,
      });
    // Idle connection failures are surfaced by subsequent queries, never as an
    // unhandled EventEmitter error or a reason to switch storage backends.
    this.pool.on("error", () => {});
  }
  async open() {
    return (this.ready ??= this.initialize());
  }
  private async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [1178747460, 1],
      );
      await client.query(
        await readFile(
          new URL("../../migrations/001_dashboard.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("COMMIT");
      await this.importLocal(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async importLocal(client: PoolClient) {
    const marker = "migration/local-files-v1";
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      advisoryKey(`import:${this.repository}`),
    );
    const imported = await client.query(
      "SELECT value FROM fullbeam_dashboard.records WHERE repository=$1 AND record_key=$2",
      [this.repository, marker],
    );
    if (imported.rowCount) {
      await client.query("COMMIT");
      return;
    }
    // A legacy filesystem worker uses a different lock mechanism. Its queue
    // must be drained before the first snapshot becomes authoritative in PG.
    try {
      const legacy = JSON.parse(
        await readFile(
          join(this.localStateDir, "dashboard-worker.json"),
          "utf8",
        ),
      ) as { pid: number };
      if (!Number.isSafeInteger(legacy.pid) || legacy.pid < 1)
        throw new Error(
          "Invalid legacy dashboard worker lock; migration stopped",
        );
      try {
        process.kill(legacy.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          // Dead lock files are retained as evidence; no process is dispatched.
          legacy.pid = 0;
        } else throw error;
      }
      if (legacy.pid)
        throw new Error(
          "Stop the running legacy dashboard worker before importing its queue into Postgres",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const names = ["dashboard-jobs.json", "dashboard/names.json"];
    for (const directory of ["completed", "workflows"])
      try {
        for (const name of await readdir(
          join(this.localStateDir, "dashboard", directory),
        )) {
          if (/^[1-9][0-9]*(?:\.enrichment-v[0-9]+)?\.json$/.test(name))
            names.push(`dashboard/${directory}/${name}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    const receipts: { key: string; sha256: string }[] = [];
    for (const key of names) {
      let value: unknown;
      try {
        const path = join(this.localStateDir, key),
          info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error(`Unsafe local dashboard import: ${key}`);
        value = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const hash = digest(value);
      const existing = await client.query(
        "SELECT value_sha256 FROM fullbeam_dashboard.records WHERE repository=$1 AND record_key=$2",
        [this.repository, key],
      );
      if (existing.rowCount && existing.rows[0].value_sha256 !== hash)
        throw new Error(
          `Postgres dashboard import conflicts with existing ${key}; refusing overwrite`,
        );
      await client.query(
        "INSERT INTO fullbeam_dashboard.records(repository, record_key, value, value_sha256) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (repository,record_key) DO NOTHING",
        [this.repository, key, canonical(value), hash],
      );
      receipts.push({ key, sha256: hash });
    }
    const value = {
      schema_version: 1,
      imported_at: new Date().toISOString(),
      records: receipts,
    };
    await client.query(
      "INSERT INTO fullbeam_dashboard.records(repository,record_key,value,value_sha256) VALUES($1,$2,$3::jsonb,$4)",
      [this.repository, marker, canonical(value), digest(value)],
    );
    await client.query("COMMIT");
  }
  scope(prefix = ""): DashboardStore {
    const key = (name: string) => {
      normalizePath(name);
      return prefix ? `${prefix}/${name}` : name;
    };
    return {
      state: <T>(name: string) => this.state<T>(key(name)),
      saveState: (name, value) => this.write(key(name), value, false),
      immutable: (name, value) => this.write(key(name), value, true),
    };
  }
  async state<T>(key: string): Promise<T | null> {
    await this.open();
    const result = await this.pool.query(
      "SELECT value,value_sha256 FROM fullbeam_dashboard.records WHERE repository=$1 AND record_key=$2",
      [this.repository, key],
    );
    if (!result.rowCount) return null;
    const { value, value_sha256 } = result.rows[0];
    if (digest(value) !== value_sha256)
      throw new Error(`Postgres dashboard record integrity failure: ${key}`);
    return value as T;
  }
  private async write(key: string, value: unknown, immutable: boolean) {
    await this.open();
    const hash = digest(value);
    // Mutable writes travel on the exact session holding the advisory lock.
    // A disconnected/stale worker cannot write through a different pool socket.
    if (!immutable) await this.assertWorker();
    const connection = immutable ? this.pool : this.worker!;
    let result;
    try {
      result = await connection.query(
        `INSERT INTO fullbeam_dashboard.records(repository,record_key,value,value_sha256) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(repository,record_key) ${immutable ? "DO NOTHING" : "DO UPDATE SET value=EXCLUDED.value,value_sha256=EXCLUDED.value_sha256,updated_at=now()"} RETURNING value_sha256`,
        [this.repository, key, canonical(value), hash],
      );
    } catch (error) {
      if (!immutable) {
        this.workerLost = true;
        throw new DashboardLockError(
          "Postgres worker write failed; queue changes and dispatch are stopped",
        );
      }
      throw error;
    }
    if (immutable && !result.rowCount) {
      const existing = await this.state(key);
      if (digest(existing) !== hash)
        throw new Error(
          `Refusing to overwrite immutable Postgres evidence: ${key}`,
        );
    }
  }
  async list(prefix: string): Promise<string[]> {
    await this.open();
    const result = await this.pool.query(
      "SELECT record_key FROM fullbeam_dashboard.records WHERE repository=$1 AND left(record_key,length($2))=$2 ORDER BY record_key",
      [this.repository, prefix],
    );
    return result.rows.map((row) => row.record_key);
  }
  async acquireWorker() {
    await this.open();
    if (this.worker) return;
    const client = await this.pool.connect();
    client.on("error", () => {
      this.workerLost = true;
    });
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired",
        advisoryKey(this.repository),
      );
      if (result.rows[0]?.acquired !== true)
        throw new DashboardLockError(
          "Another dashboard worker already holds the repository's Postgres lock",
        );
      this.worker = client;
      this.workerLost = false;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  async assertWorker() {
    if (!this.worker || this.workerLost)
      throw new DashboardLockError(
        "Postgres worker lock is unavailable; dashboard dispatch is stopped",
      );
    try {
      await this.worker.query("SELECT 1");
    } catch {
      this.workerLost = true;
      throw new DashboardLockError(
        "Postgres worker connection was lost; dashboard dispatch is stopped",
      );
    }
  }
  async close() {
    return (this.closing ??= (async () => {
      if (this.worker) {
        if (!this.workerLost)
          await this.worker
            .query(
              "SELECT pg_advisory_unlock($1::integer,$2::integer)",
              advisoryKey(this.repository),
            )
            .catch(() => {});
        this.worker.release(this.workerLost);
        this.worker = undefined;
      }
      await this.pool.end();
    })());
  }
}
