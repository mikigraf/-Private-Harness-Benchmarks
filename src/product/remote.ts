import {
  InstacloudExecutor,
  type EnvironmentRef,
  type ArtifactManifest,
  type AttemptInput,
} from "../execution/instacloud.js";
import { ResourceJournal } from "../core/checkpoints.js";
import { EvidenceStore } from "../core/store.js";
import { type Config, DEFAULT_POLICY } from "../core/config.js";
import type { RuntimeLock } from "./types.js";
import type { FileEntry } from "../core/integrity.js";
export class RemoteController {
  readonly executor: InstacloudExecutor;
  readonly journal: ResourceJournal;
  private operationDeadline?: number;
  private readonly ownedAttempts = new Set<string>();
  constructor(
    readonly config: Config,
    readonly runtime: RuntimeLock,
    readonly store: EvidenceStore,
    readonly runId: string,
    private readonly sharedJournal?: ResourceJournal,
  ) {
    this.journal = sharedJournal ?? new ResourceJournal(store, runId);
    this.executor = new InstacloudExecutor({
      apiKey: config.instacloudToken,
      orgId: config.orgId,
      generationProjectId: runtime.projects.generation,
      verifierProjectId: runtime.projects.verification,
      region: runtime.region,
      openaiApiKey: config.openaiKey,
      model: config.model,
      runtimeImages: runtime.images,
      operationDeadline: () => this.operationDeadline,
      onEnvironmentIntent: async (env) => this.journal.append("INTENT", env),
      onEnvironmentAllocated: async (env) =>
        this.journal.append("ALLOCATED", env),
    });
  }
  async initialize() {
    if (!this.sharedJournal) await this.journal.load();
  }
  /** Call after initialize; workers share durable ordering, never deadlines. */
  fork(): RemoteController {
    return new RemoteController(
      this.config,
      this.runtime,
      this.store,
      this.runId,
      this.journal,
    );
  }
  async execute(
    id: string,
    files: FileEntry[],
    input: AttemptInput,
  ): Promise<{
    result: ArtifactManifest;
    environment: EnvironmentRef;
    cleanup: "CONFIRMED" | "FAILED";
  }> {
    this.ownedAttempts.add(JSON.stringify([id, input.role]));
    let environment: EnvironmentRef | undefined,
      result: ArtifactManifest | undefined;
    let cleanup: "CONFIRMED" | "FAILED" = "CONFIRMED";
    const startedAt = Date.now(),
      deadline =
        startedAt +
        (input.timeoutSeconds + DEFAULT_POLICY.setup_timeout_seconds + 60) *
          1000;
    this.operationDeadline =
      startedAt + DEFAULT_POLICY.setup_timeout_seconds * 1000;
    try {
      environment = await this.executor.createAttemptEnvironment({
        id,
        role: input.role,
      });
      await this.executor.putBundle(environment, { files });
      const ref = await this.executor.start(environment, input);
      this.operationDeadline = deadline;
      for (;;) {
        if (process.exitCode === 130) throw new Error("CANCELLED");
        const status = await this.executor.poll(ref);
        if (status.state !== "RUNNING") break;
        if (Date.now() > deadline)
          throw new Error(
            "Supervised attempt did not finish within its outer deadline",
          );
        await new Promise((r) => setTimeout(r, 1500));
      }
      result = await this.executor.collect(ref);
      if (!result.integrityVerified)
        throw new Error("Remote output integrity was not verified");
    } finally {
      this.operationDeadline = undefined;
      const pending = this.journal
        .pending()
        .filter((e) => e.id === id && e.role === input.role);
      for (const allocated of pending) {
        try {
          await this.executor.destroy(allocated);
          await this.journal.append("DELETED", allocated);
        } catch {
          cleanup = "FAILED";
          await this.journal.append("CLEANUP_FAILED", allocated);
        }
      }
    }
    if (!environment || !result)
      throw new Error("Execution did not produce a result");
    return { result, environment, cleanup };
  }
  async cleanup(): Promise<boolean> {
    this.operationDeadline = undefined;
    let complete = true;
    for (const environment of this.journal.pending()) {
      if (
        this.sharedJournal &&
        !this.ownedAttempts.has(
          JSON.stringify([environment.id, environment.role]),
        )
      )
        continue;
      try {
        await this.executor.destroy(environment);
        await this.journal.append("DELETED", environment);
      } catch {
        complete = false;
        await this.journal.append("CLEANUP_FAILED", environment);
      }
    }
    return complete;
  }
  async close() {
    try {
      if (!(await this.cleanup()))
        throw new Error(
          "Remote cleanup remains incomplete; recorded resources require cleanup retry",
        );
    } finally {
      await this.executor.close();
    }
  }
}
