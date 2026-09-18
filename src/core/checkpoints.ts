import { DefaultArtifactClient } from "@actions/artifact";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonical, digest } from "./integrity.js";
import { EvidenceStore } from "./store.js";
export async function regularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string) {
    for (const d of await readdir(path, { withFileTypes: true })) {
      const next = join(path, d.name);
      if (d.isSymbolicLink())
        throw new Error("Artifact directory contains symlink");
      if (d.isDirectory()) await visit(next);
      else if (d.isFile()) output.push(next);
      else throw new Error("Artifact directory contains nonregular file");
    }
  }
  await visit(root);
  return output;
}
export async function uploadEvidence(
  store: EvidenceStore,
  name: string,
): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const files = await evidenceFiles(store.root);
  if (files.length)
    await new DefaultArtifactClient().uploadArtifact(name, files, store.root, {
      retentionDays: 30,
    });
}
/** Mutable indexes can race with a worker; immutable event files rebuild them. */
export async function evidenceFiles(root: string): Promise<string[]> {
  return (await regularFiles(root)).filter((file) => {
    const path = relative(root, file).replaceAll("\\", "/");
    return !path.startsWith("journals/") && !path.endsWith(".tmp");
  });
}
export interface ResourceRecord {
  id: string;
  role: "generation" | "verification";
  projectId: string;
  branch: string;
  providerId?: string;
}
export interface JournalEvent {
  schema_version: 1;
  sequence: number;
  at: string;
  kind: "INTENT" | "ALLOCATED" | "DELETED" | "CLEANUP_FAILED";
  environment: ResourceRecord;
  run_id: string;
}
export type JournalCheckpoint = (
  event: JournalEvent,
  file: string,
  root: string,
) => Promise<void>;
export class ResourceJournal {
  private events: JournalEvent[] = [];
  private checkpoints = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly store: EvidenceStore,
    readonly runId: string,
    private readonly checkpoint?: JournalCheckpoint,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(runId))
      throw new Error("Invalid journal identity");
  }
  async load() {
    const saved =
      (await this.store.state<JournalEvent[]>(`journals/${this.runId}.json`)) ??
      [];
    if (!Array.isArray(saved)) throw new Error("Invalid journal index");
    let names: string[] = [];
    try {
      names = await readdir(
        join(this.store.root, "journal-events", this.runId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const immutable: JournalEvent[] = [];
    for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
      const event = await this.store.state<JournalEvent>(
        `journal-events/${this.runId}/${name}`,
      );
      if (!event || event.sequence !== Number(name.slice(0, -5)))
        throw new Error("Journal sequence identity mismatch");
      immutable.push(event);
    }
    immutable.sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < immutable.length; i++) {
      const event = immutable[i]!;
      this.validate(event);
      if (event.sequence !== i)
        throw new Error("Journal immutable sequence has a gap");
      if (saved[i] && digest(saved[i]) !== digest(event))
        throw new Error("Journal index disagrees with immutable evidence");
    }
    if (saved.length > immutable.length)
      throw new Error("Journal index is missing immutable event evidence");
    this.events = immutable;
    this.checkpoints.clear();
    for (const event of immutable) {
      const receipt = await this.store.state<{ event_digest: string }>(
        `journal-checkpoints/${this.runId}/${event.sequence}.json`,
      );
      if (receipt) {
        if (receipt.event_digest !== digest(event))
          throw new Error("Journal checkpoint receipt mismatch");
        this.checkpoints.add(receipt.event_digest);
      }
    }
  }
  private validate(event: JournalEvent) {
    if (
      event.schema_version !== 1 ||
      event.run_id !== this.runId ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      !Number.isFinite(Date.parse(event.at)) ||
      !["INTENT", "ALLOCATED", "DELETED", "CLEANUP_FAILED"].includes(
        event.kind,
      ) ||
      !event.environment ||
      !["generation", "verification"].includes(event.environment.role) ||
      !event.environment.id ||
      !event.environment.projectId ||
      !/^[a-z0-9-]{1,39}$/.test(event.environment.branch)
    )
      throw new Error("Invalid resource journal event");
  }
  private async ensureCheckpoint(event: JournalEvent) {
    const hash = digest(event);
    if (
      this.checkpoints.has(hash) ||
      (!this.checkpoint && process.env.GITHUB_ACTIONS !== "true")
    )
      return;
    const root = join(this.store.root, "journal-events", this.runId),
      file = join(root, `${event.sequence}.json`);
    if (this.checkpoint) await this.checkpoint(event, file, root);
    else {
      const client = new DefaultArtifactClient();
      const name = `fb-resource-${this.runId}-${event.sequence}-${hash.slice(0, 10)}`;
      try {
        await client.uploadArtifact(name, [file], root, { retentionDays: 30 });
      } catch (error) {
        // Upload may have succeeded before its response was lost. The immutable artifact
        // name binds this exact persisted event; never mint new bytes at its sequence.
        try {
          const existing = await client.getArtifact(name);
          if (existing.artifact.name !== name) throw error;
        } catch {
          throw error;
        }
      }
    }
    await this.store.immutable(
      `journal-checkpoints/${this.runId}/${event.sequence}.json`,
      { event_digest: hash },
    );
    this.checkpoints.add(hash);
  }
  async append(
    kind: JournalEvent["kind"],
    environment: ResourceRecord,
  ): Promise<void> {
    const operation = this.queue.then(async () => {
      // Reconcile every pending checkpoint before permitting another lifecycle action.
      for (const prior of this.events) await this.ensureCheckpoint(prior);
      const last = this.events.at(-1);
      if (
        last?.kind === kind &&
        digest(last.environment) === digest(environment)
      ) {
        await this.store.saveState(`journals/${this.runId}.json`, this.events);
        return;
      }
      const event: JournalEvent = {
        schema_version: 1,
        sequence: this.events.length,
        at: new Date().toISOString(),
        kind,
        environment: structuredClone(environment),
        run_id: this.runId,
      };
      this.validate(event);
      await this.store.immutable(
        `journal-events/${this.runId}/${event.sequence}.json`,
        event,
      );
      // Local immutable evidence remains recoverable even if upload/index persistence fails.
      this.events.push(event);
      await this.ensureCheckpoint(event);
      await this.store.saveState(`journals/${this.runId}.json`, this.events);
    });
    this.queue = operation.catch(() => {});
    await operation;
  }
  pending(): ResourceRecord[] {
    const pending = new Map<string, ResourceRecord>();
    for (const e of this.events) {
      const k = `${e.environment.projectId}/${e.environment.branch}`;
      if (e.kind === "DELETED") pending.delete(k);
      else pending.set(k, e.environment);
    }
    return [...pending.values()];
  }
  snapshot(): JournalEvent[] {
    return structuredClone(this.events);
  }
}
