import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  InstacloudExecutor,
  InstacloudCli,
  INSTA_CLI_VERSION,
  type ExecutorOptions,
} from "../execution/instacloud.js";
import { type Config } from "../core/config.js";
import { EvidenceStore } from "../core/store.js";
import { ResourceJournal } from "../core/checkpoints.js";
import { digest } from "../core/integrity.js";
import { CODEX_VERSION } from "../harness/resolve.js";
import type { RuntimeLock } from "./types.js";
type SetupExecutor = Pick<
  InstacloudExecutor,
  "provisionTemplates" | "preflight" | "destroy" | "close"
>;
export interface RuntimeSetupDependencies {
  run?: (args: string[]) => Promise<any>;
  executorFactory?: (options: ExecutorOptions) => SetupExecutor;
}
interface AllocationState {
  schema_version: 1;
  source_digest: string;
  org_id: string;
  repository: string;
  roles: Partial<
    Record<"generation" | "verification", { name: string; id?: string }>
  >;
}
interface StoredRuntime extends RuntimeLock {
  source_digest: string;
  org_id: string;
  repository: string;
}
export async function runtimeSourceDigest(): Promise<string> {
  const paths = [
    "runtime/Dockerfile",
    "runtime/supervisor.mjs",
    "runtime/.dockerignore",
    "runtime/package.json",
    "runtime/package-lock.json",
    "templates/relaydesk/generation/package-lock.json",
  ];
  const inputs = await Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: (await readFile(path)).toString("base64"),
    })),
  );
  return digest({
    inputs,
    nativeClient: CODEX_VERSION,
    instaClient: INSTA_CLI_VERSION,
  });
}
function projectRows(
  value: unknown,
): { id: string; name: string; org_id?: string }[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (p) => !p || typeof p.id !== "string" || typeof p.name !== "string",
    )
  )
    throw new Error("Instacloud project list omitted identity evidence");
  return value;
}
export async function setupRuntime(
  config: Config,
  store: EvidenceStore,
  dependencies: RuntimeSetupDependencies = {},
): Promise<RuntimeLock> {
  const sourceDigest = await runtimeSourceDigest();
  const prior = await store.state<StoredRuntime>("runtime.json");
  if (prior) {
    if (prior.source_digest !== sourceDigest)
      throw new Error(
        "Runtime source changed or prior lock lacks source identity; existing immutable templates are stale. Provision a new reviewed template set before recalibration.",
      );
    if (
      prior.org_id !== config.orgId ||
      prior.repository !== config.demoRepository ||
      prior.region !== config.region
    )
      throw new Error(
        "Runtime lock belongs to a different organization, repository or region",
      );
    if (
      prior.application_digest !==
      digest({ sourceDigest, images: prior.images })
    )
      throw new Error("Runtime lock integrity mismatch");
    if (prior.capability.status === "READY") return prior;
  }
  let allocations = await store.state<AllocationState>(
    "template-allocation.json",
  );
  if (
    allocations &&
    (allocations.source_digest !== sourceDigest ||
      allocations.org_id !== config.orgId ||
      allocations.repository !== config.demoRepository)
  )
    throw new Error(
      "Pending immutable template allocation belongs to different source or account",
    );
  allocations ??= {
    schema_version: 1,
    source_digest: sourceDigest,
    org_id: config.orgId,
    repository: config.demoRepository,
    roles: {},
  };
  const cli = new InstacloudCli({
    apiKey: config.instacloudToken,
    orgId: config.orgId,
    openaiApiKey: config.openaiKey,
  });
  const run = dependencies.run ?? ((args: string[]) => cli.run(args));
  let projects: RuntimeLock["projects"];
  try {
    const regions = await run(["config", "regions", "--json"]);
    if (
      !Array.isArray(regions) ||
      !regions.some((region) => region?.slug === config.region)
    )
      throw new Error(
        `Configured region ${config.region} not returned by insta config regions`,
      );
    for (const role of ["generation", "verification"] as const) {
      const rows = projectRows(
        await run(["project", "list", "--org", config.orgId, "--json"]),
      );
      const name = `fb-${role === "generation" ? "gen" : "verify"}-${digest({ org: config.orgId, repo: config.demoRepository, source: sourceDigest }).slice(0, 16)}`;
      const matches = rows.filter(
        (p) => p.name === name && (!p.org_id || p.org_id === config.orgId),
      );
      const recorded = allocations.roles[role];
      if (matches.length > 1)
        throw new Error(
          `Ambiguous ${role} template project recovery: multiple exact org/name matches`,
        );
      if (recorded) {
        if (recorded.name !== name)
          throw new Error("Template intent name mismatch");
        if (recorded.id) {
          if (matches.length !== 1 || matches[0]!.id !== recorded.id)
            throw new Error(
              "Recorded template project is missing or its identity changed",
            );
          continue;
        }
        if (matches.length === 1) {
          recorded.id = matches[0]!.id;
          await store.saveState("template-allocation.json", allocations);
          continue;
        }
      } else {
        if (matches.length)
          throw new Error(
            "Existing template project has no recorded allocation intent; refusing to adopt unrelated resources",
          );
        allocations.roles[role] = { name };
        await store.saveState("template-allocation.json", allocations);
      }
      const created = await run([
        "project",
        "create",
        name,
        "--org",
        config.orgId,
        "--json",
      ]);
      const project = created?.project;
      if (
        typeof project?.id !== "string" ||
        project.name !== name ||
        (project.org_id && project.org_id !== config.orgId)
      )
        throw new Error(
          "Instacloud project creation returned mismatched identity; resume will recover by recorded org/name intent",
        );
      allocations.roles[role]!.id = project.id;
      await store.saveState("template-allocation.json", allocations);
    }
    projects = {
      generation: allocations.roles.generation!.id!,
      verification: allocations.roles.verification!.id!,
    };
    if (projects.generation === projects.verification)
      throw new Error("Templates must be separate projects");
    await store.saveState("template-projects.json", projects);
  } finally {
    await cli.close();
  }
  const journal = new ResourceJournal(store, `setup-${randomUUID()}`);
  await journal.load();
  const pinned = await store.state<{
    source_digest: string;
    images: RuntimeLock["images"];
  }>("template-images.json");
  if (pinned && pinned.source_digest !== sourceDigest)
    throw new Error("Immutable template image source binding mismatch");
  const executor = (
    dependencies.executorFactory ??
    ((options) => new InstacloudExecutor(options))
  )({
    apiKey: config.instacloudToken,
    orgId: config.orgId,
    generationProjectId: projects.generation,
    verifierProjectId: projects.verification,
    region: config.region,
    openaiApiKey: config.openaiKey,
    model: config.model,
    ...(pinned ? { runtimeImages: pinned.images } : {}),
    onEnvironmentIntent: async (e) => journal.append("INTENT", e),
    onEnvironmentAllocated: async (e) => journal.append("ALLOCATED", e),
  });
  try {
    const images =
      pinned?.images ?? (await executor.provisionTemplates("runtime"));
    await store.saveState("template-images.json", {
      source_digest: sourceDigest,
      images,
    });
    const capability = await executor.preflight();
    await store.saveState("preflight.json", capability);
    if (capability.status !== "READY")
      throw new Error(
        `Instacloud preflight BLOCKED: ${capability.blockers.join("; ")}`,
      );
    const application_digest = digest({ sourceDigest, images });
    const lock: StoredRuntime = {
      schema_version: 1,
      projects,
      images,
      application_digest,
      region: config.region,
      cli_version: INSTA_CLI_VERSION,
      codex_version: CODEX_VERSION,
      capability,
      created_at: new Date().toISOString(),
      source_digest: sourceDigest,
      org_id: config.orgId,
      repository: config.demoRepository,
    };
    await store.saveState("runtime.json", lock);
    return lock;
  } finally {
    try {
      for (const env of journal.pending()) {
        try {
          await executor.destroy(env);
          await journal.append("DELETED", env);
        } catch {
          await journal.append("CLEANUP_FAILED", env);
        }
      }
    } finally {
      await executor.close();
    }
  }
}
