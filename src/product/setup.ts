import { mkdir, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type Config,
  DEFAULT_POLICY,
  assertPublicEnvironmentTemplate,
} from "../core/config.js";
import { EvidenceStore } from "../core/store.js";
import {
  digest,
  makeFile,
  manifestDigest,
  overlayFiles,
  type FileEntry,
} from "../core/integrity.js";
import {
  GitHubBootstrap,
  GitHubApiError,
  type GitHubClient,
} from "../github/index.js";
import { materializeFixture, seedTasks } from "../benchmark/relaydesk.js";
import { readDirectory, gitCommitFiles } from "./files.js";
import {
  github,
  configureActions,
  defaultHead,
  readRepoJson,
} from "./github-context.js";
import { runtimeSourceDigest, setupRuntime } from "./runtime-setup.js";
import type { DemoState, RuntimeLock } from "./types.js";
import { checkBootstrapAccounts } from "./account-preflight.js";

const CONTROLLER_LOCK_PATH = ".fullbeam/controller.lock.json";
const RUNTIME_LOCK_PATH = ".fullbeam/runtime.lock.json";

interface PersistedRuntime extends RuntimeLock {
  source_digest: string;
  org_id: string;
  repository: string;
}

interface TemplateAllocation {
  schema_version: 1;
  source_digest: string;
  org_id: string;
  repository: string;
  roles: {
    generation: { name: string; id: string };
    verification: { name: string; id: string };
  };
}

export interface ControllerPayloadLock {
  schema_version: 1;
  repository_id: number;
  repository: string;
  payload_digest: string;
  payload_paths?: string[];
  runtime_application_digest: string;
}

export function controllerPayloadLock(
  repositoryId: number,
  repository: string,
  runtime: RuntimeLock,
  payload: FileEntry[],
): ControllerPayloadLock {
  return {
    schema_version: 1,
    repository_id: repositoryId,
    repository,
    payload_digest: manifestDigest(payload),
    payload_paths: payload.map((file) => file.path).sort(),
    runtime_application_digest: runtime.application_digest,
  };
}

function isManagedPayloadPath(path: string): boolean {
  return (
    path.startsWith(".fullbeam/controller/") ||
    path === RUNTIME_LOCK_PATH ||
    path === ".fullbeam/policy.json" ||
    path === ".github/CODEOWNERS" ||
    /^\.github\/workflows\/fullbeam-[^/]+\.ya?ml$/.test(path)
  );
}

export function managedPayloadDeletions(
  previousPaths: string[],
  payload: FileEntry[],
): string[] {
  if (previousPaths.some((path) => !isManagedPayloadPath(path)))
    throw new Error("Controller lock contains a non-managed payload path");
  const current = new Set(payload.map((file) => file.path));
  return [...new Set(previousPaths)]
    .filter((path) => !current.has(path))
    .sort();
}

const RUNTIME_STATE_FILES = [
  "runtime.json",
  "template-allocation.json",
  "template-images.json",
  "template-projects.json",
  "preflight.json",
] as const;
export async function archiveRuntimeState(
  store: EvidenceStore,
  at = new Date(),
): Promise<string> {
  const archive = join(
    store.root,
    "runtime-revisions",
    `${at.toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const name of RUNTIME_STATE_FILES) {
    try {
      await rename(join(store.root, name), join(archive, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return archive;
}

export function invalidateQualificationForRuntimeChange(
  state: DemoState,
  previousRuntimeDigest: string | null,
  runtimeDigest: string,
): DemoState {
  return previousRuntimeDigest === runtimeDigest
    ? { ...state }
    : { ...state, qualified: false };
}

/** Preserve only exact local merge receipts after repository ownership is verified.
 * Setup's remote state remains authoritative for runtime and qualification. A
 * local receipt may be newer when GitHub merged a seed but the ledger push failed;
 * demo still verifies it against the live PR and squash parent before recovery.
 */
export async function saveSetupRecoveryState(
  store: EvidenceStore,
  remote: DemoState,
): Promise<void> {
  const local = await store.state<DemoState>("demo-state.json");
  const next = structuredClone(remote);
  if (
    local?.repository_id === remote.repository_id &&
    local.repository.toLowerCase() === remote.repository.toLowerCase()
  ) {
    next.items = remote.items.map((item) => {
      if (item.merge_receipt || !seedTasks.some((seed) => seed.id === item.id))
        return item;
      const saved = local.items.find((candidate) => candidate.id === item.id);
      const receipt = saved?.merge_receipt;
      if (
        !saved ||
        !receipt ||
        !saved.base ||
        !saved.reference ||
        saved.issue !== item.issue ||
        saved.pr !== item.pr ||
        saved.head !== item.head ||
        saved.branch !== item.branch ||
        digest(saved.issue_snapshot) !== digest(item.issue_snapshot) ||
        receipt.marker !== item.id ||
        receipt.pullNumber !== item.pr ||
        receipt.headSha !== item.head ||
        receipt.mergeMethod !== "squash" ||
        receipt.mergeCommitSha !== saved.reference ||
        !saved.approved_by ||
        receipt.approvedBy !== saved.approved_by ||
        (receipt.reviewMode ?? "HUMAN") !== (saved.review_mode ?? "HUMAN") ||
        !/^[a-f0-9]{40}$/.test(saved.base) ||
        !/^[a-f0-9]{40}$/.test(saved.reference)
      )
        return item;
      return {
        ...item,
        approved_by: saved.approved_by,
        ...(saved.review_mode ? { review_mode: saved.review_mode } : {}),
        ...(saved.review_evidence
          ? { review_evidence: saved.review_evidence }
          : {}),
        merge_receipt: receipt,
        base: saved.base,
        reference: saved.reference,
      };
    });
  }
  await store.saveState("demo-state.json", next);
}

function templateName(
  role: "generation" | "verification",
  config: Config,
  sourceDigest: string,
): string {
  return `fb-${role === "generation" ? "gen" : "verify"}-${digest({ org: config.orgId, repo: config.demoRepository, source: sourceDigest }).slice(0, 16)}`;
}

/** Adopt only the runtime already bound to the authenticated, marker-verified repository. */
export async function hydrateAuthorizedRuntime(
  config: Config,
  store: EvidenceStore,
  remote: PersistedRuntime,
  expectedSourceDigest: string,
): Promise<void> {
  if (remote.source_digest !== expectedSourceDigest)
    throw new Error(
      "Repository runtime source differs from this trusted controller; explicit reviewed reprovisioning is required",
    );
  if (
    remote.org_id !== config.orgId ||
    remote.repository !== config.demoRepository ||
    remote.region !== config.region
  )
    throw new Error(
      "Repository runtime belongs to a different organization, repository, or region",
    );
  if (remote.capability.status !== "READY")
    throw new Error("Repository runtime has not passed mandatory preflight");
  if (
    remote.application_digest !==
    digest({ sourceDigest: remote.source_digest, images: remote.images })
  )
    throw new Error("Repository runtime integrity mismatch");
  const local = await store.state<PersistedRuntime>("runtime.json");
  if (local && digest(local) !== digest(remote))
    throw new Error(
      "Local and authorized repository runtime identities conflict",
    );
  const allocation: TemplateAllocation = {
    schema_version: 1,
    source_digest: remote.source_digest,
    org_id: remote.org_id,
    repository: remote.repository,
    roles: {
      generation: {
        name: templateName("generation", config, remote.source_digest),
        id: remote.projects.generation,
      },
      verification: {
        name: templateName("verification", config, remote.source_digest),
        id: remote.projects.verification,
      },
    },
  };
  const pending = await store.state<TemplateAllocation>(
    "template-allocation.json",
  );
  if (pending && digest(pending) !== digest(allocation))
    throw new Error(
      "Local template allocation conflicts with the authorized repository runtime",
    );
  await store.saveState("runtime.json", remote);
  await store.saveState("template-allocation.json", allocation);
  await store.saveState("template-projects.json", remote.projects);
  await store.saveState("template-images.json", {
    source_digest: remote.source_digest,
    images: remote.images,
  });
  await store.saveState("preflight.json", remote.capability);
}

async function optionalRepoJson<T>(
  client: GitHubClient,
  path: string,
  ref: string,
): Promise<T | null> {
  try {
    return await readRepoJson<T>(client, path, ref);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function setupProduct(
  config: Config,
  options: { refreshRuntime?: boolean } = {},
): Promise<{ state: DemoState; runtime: RuntimeLock }> {
  assertPublicEnvironmentTemplate(await readFile(".env.example", "utf8"));
  await checkBootstrapAccounts(config);
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  const client = github(config, config.demoRepository);
  const actor = await client.authenticatedActor();
  const marker = `fullbeam-${digest(config.demoRepository.toLowerCase()).slice(0, 24)}`;
  const repository = await new GitHubBootstrap(client).ensurePrivateRepository({
    ownerKind:
      actor.login.toLowerCase() === client.repository.owner.toLowerCase()
        ? "user"
        : "organization",
    mode: "seed",
    seedOwnerMarker: marker,
    description: "Fullbeam Compare — owned seeded RelayDesk evaluation fixture",
  });
  const scoped = github(config, config.demoRepository, repository.id);
  const scopedBootstrap = new GitHubBootstrap(scoped);
  let head = await defaultHead(scoped);
  // Verify private-branch protection entitlement before any paid cloud allocation.
  await scoped.rest(
    "PUT",
    `branches/${encodeURIComponent(repository.default_branch)}/protection`,
    {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    },
  );
  const existingState = await optionalRepoJson<DemoState>(
    scoped,
    ".fullbeam/demo-state.json",
    head.sha,
  );
  if (
    existingState &&
    (existingState.repository_id !== repository.id ||
      existingState.repository.toLowerCase() !==
        config.demoRepository.toLowerCase())
  )
    throw new Error(
      "Existing demo state belongs to a different repository identity",
    );
  const remoteRuntime = await optionalRepoJson<PersistedRuntime>(
    scoped,
    RUNTIME_LOCK_PATH,
    head.sha,
  );
  const sourceDigest = await runtimeSourceDigest();
  const requiresRefresh = options.refreshRuntime === true;
  if (requiresRefresh) {
    const intent = await store.state<{
      source_digest: string;
      org_id: string;
      repository: string;
    }>("runtime-refresh.json");
    if (
      !intent ||
      intent.source_digest !== sourceDigest ||
      intent.org_id !== config.orgId ||
      intent.repository !== config.demoRepository
    ) {
      const archive = await archiveRuntimeState(store);
      await store.saveState("runtime-refresh.json", {
        schema_version: 1,
        source_digest: sourceDigest,
        org_id: config.orgId,
        repository: config.demoRepository,
        archive,
        started_at: new Date().toISOString(),
      });
    }
  } else if (remoteRuntime)
    await hydrateAuthorizedRuntime(config, store, remoteRuntime, sourceDigest);
  const runtime = await setupRuntime(config, store);
  if (
    remoteRuntime &&
    !requiresRefresh &&
    digest(remoteRuntime) !== digest(runtime)
  )
    throw new Error(
      "Runtime setup diverged from the authorized immutable repository lock",
    );

  let state = existingState ?? {
    schema_version: 1 as const,
    repository_id: repository.id,
    repository: config.demoRepository,
    default_branch: repository.default_branch,
    items: [],
  };
  const trustedPayload = [
    ...(await controllerPayload(actor.login)),
    makeFile(RUNTIME_LOCK_PATH, JSON.stringify(runtime)),
    makeFile(".fullbeam/policy.json", JSON.stringify(DEFAULT_POLICY)),
  ];
  const payloadLock = controllerPayloadLock(
    repository.id,
    config.demoRepository,
    runtime,
    trustedPayload,
  );
  const existingLock = await optionalRepoJson<ControllerPayloadLock>(
    scoped,
    CONTROLLER_LOCK_PATH,
    head.sha,
  );
  if (
    existingLock &&
    (existingLock.repository_id !== repository.id ||
      existingLock.repository.toLowerCase() !==
        config.demoRepository.toLowerCase())
  )
    throw new Error(
      "Controller payload lock belongs to a different repository identity",
    );
  state = invalidateQualificationForRuntimeChange(
    state,
    existingState
      ? (existingLock?.runtime_application_digest ?? null)
      : runtime.application_digest,
    runtime.application_digest,
  );

  if (!existingState) {
    const fixture = await materializeFixture(0);
    const native = fixture.find((file) => file.path === ".codex/config.toml");
    if (!native) throw new Error("Fixture native config missing");
    const initial = overlayFiles(fixture, [
      makeFile(
        ".codex/config.toml",
        Buffer.from(native.content, "base64").toString() +
          `\nmodel = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}\n`,
      ),
      makeFile(
        ".fullbeam/seed-owner.json",
        JSON.stringify({ marker, created_by: actor.login }),
      ),
      makeFile(".fullbeam/demo-state.json", JSON.stringify(state)),
      ...trustedPayload,
      makeFile(CONTROLLER_LOCK_PATH, JSON.stringify(payloadLock)),
    ]);
    await scopedBootstrap.commitFiles({
      branch: head.branch,
      baseCommitSha: head.sha,
      message: "Initialize Fullbeam RelayDesk demo and protected controller",
      files: gitCommitFiles(initial),
    });
  } else {
    const runtimeChanged =
      existingLock?.runtime_application_digest !== runtime.application_digest;
    if (
      !existingLock ||
      existingLock.payload_digest !== payloadLock.payload_digest ||
      existingLock.runtime_application_digest !==
        payloadLock.runtime_application_digest ||
      runtimeChanged
    ) {
      const synchronization = [
        ...trustedPayload,
        makeFile(CONTROLLER_LOCK_PATH, JSON.stringify(payloadLock)),
      ];
      if (runtimeChanged)
        synchronization.push(
          makeFile(".fullbeam/demo-state.json", JSON.stringify(state)),
        );
      head = await defaultHead(scoped);
      const previousPaths =
        existingLock?.payload_paths ??
        (await remoteManagedPayloadPaths(scoped, head.sha));
      const deletePaths = managedPayloadDeletions(
        previousPaths,
        trustedPayload,
      );
      await scopedBootstrap.commitFiles({
        branch: head.branch,
        baseCommitSha: head.sha,
        message: "Synchronize trusted Fullbeam controller payload",
        files: gitCommitFiles(synchronization),
        deletePaths,
      });
    }
  }

  await configureActions(scoped, config);
  await scoped.rest("PATCH", "", {
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: false,
  });
  for (const [name, description] of Object.entries({
    "fullbeam:eval-candidate":
      "Curated evaluation intake; not GOLD certification",
    "fullbeam:eval-exclude": "Explicit evaluation exclusion",
    "fullbeam:compare": "Harness comparison request",
    "fullbeam:seeded-demo": "Owned seeded history, not customer workload",
    "area:tenant-isolation": "Tenant isolation behavior",
    "area:idempotency": "Idempotency behavior",
    "area:pagination": "Pagination behavior",
    "risk:critical": "Owner-designated critical guardrail",
  })) {
    try {
      await scoped.rest("POST", "labels", {
        name,
        color: name.startsWith("risk") ? "b60205" : "1d76db",
        description,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422))
        throw error;
    }
  }
  await saveSetupRecoveryState(store, state);
  return { state, runtime };
}

async function remoteManagedPayloadPaths(
  client: GitHubClient,
  ref: string,
): Promise<string[]> {
  const tree = await client.rest<{
    truncated: boolean;
    tree: { path: string; type: string }[];
  }>("GET", `git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.truncated)
    throw new Error("Cannot safely synchronize a truncated controller tree");
  return tree.tree
    .filter(
      (entry) => entry.type === "blob" && isManagedPayloadPath(entry.path),
    )
    .map((entry) => entry.path)
    .sort();
}

export async function controllerPayload(owner: string): Promise<FileEntry[]> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner))
    throw new Error("Invalid authenticated GitHub actor for CODEOWNERS");
  assertPublicEnvironmentTemplate(await readFile(".env.example", "utf8"));
  const files: FileEntry[] = [];
  for (const directory of ["src", "runtime", "templates", "prd", "migrations"])
    for (const file of await readDirectory(directory))
      files.push({
        ...file,
        path: `.fullbeam/controller/${directory}/${file.path}`,
      });
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".env.example",
  ])
    files.push(makeFile(`.fullbeam/controller/${path}`, await readFile(path)));
  for (const name of ["fullbeam-compare.yml", "fullbeam-cleanup.yml"])
    files.push(
      makeFile(
        `.github/workflows/${name}`,
        await readFile(`templates/workflows/${name}`),
      ),
    );
  files.push(
    makeFile(
      ".github/CODEOWNERS",
      `/.fullbeam/ @${owner}\n/.github/workflows/ @${owner}\n`,
    ),
  );
  return files;
}
