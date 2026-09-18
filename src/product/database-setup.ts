import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { Client } from "pg";
import { type Config, redact } from "../core/config.js";
import { EvidenceStore } from "../core/store.js";
import { digest, sha256 } from "../core/integrity.js";
import { InstacloudCli } from "../execution/instacloud.js";

export interface DatabaseSetupDependencies {
  envPath?: string;
  run?: (
    args: string[],
    context?: { projectId?: string; branch?: string },
  ) => Promise<any>;
  verify?: (url: string) => Promise<{ serverVersion: string }>;
}

interface DatabaseAllocation {
  schema_version: 1;
  org_id: string;
  repository: string;
  project_name: string;
  project_id?: string;
}
interface Project {
  id: string;
  name: string;
  org_id?: string;
}
interface DatabaseReceipt {
  schema_version: 1;
  project_id: string | null;
  service_id: string | null;
  service_name: string | null;
  branch: "main";
  connection_digest: string;
  connection_verified: true;
  server_version: string;
  observed_at: string;
}
const serviceName = "fullbeam-db";

function databaseAddress(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid authenticated PostgreSQL URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    /[\r\n]/.test(value)
  )
    throw new Error(
      "DATABASE_URL must be a valid authenticated PostgreSQL URL",
    );
  return url;
}

async function verifyConnection(
  value: string,
): Promise<{ serverVersion: string }> {
  const url = databaseAddress(value);
  // Preserve pg 8's verified TLS semantics explicitly, without modifying the provider DSN.
  if (
    ["require", "prefer", "verify-ca"].includes(
      url.searchParams.get("sslmode") ?? "",
    )
  )
    url.searchParams.set("sslmode", "verify-full");
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30_000,
    query_timeout: 15_000,
  });
  try {
    await client.connect();
    const result = await client.query<{
      connected: number;
      server_version: string;
    }>(
      "SELECT 1::int AS connected, current_setting('server_version') AS server_version",
    );
    if (
      result.rows[0]?.connected !== 1 ||
      typeof result.rows[0].server_version !== "string"
    )
      throw new Error(
        "PostgreSQL did not return an authenticated connection receipt",
      );
    return { serverVersion: result.rows[0].server_version };
  } finally {
    await client.end();
  }
}

function projectRows(value: unknown): Project[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (p) => !p || typeof p.id !== "string" || typeof p.name !== "string",
    )
  )
    throw new Error("InstaCloud project list omitted identity evidence");
  return value;
}

async function protectTemplates(
  store: EvidenceStore,
  projectId: string | undefined,
) {
  if (!projectId) return;
  const [projects, runtime] = await Promise.all([
    store.state<Record<string, string>>("template-projects.json"),
    store.state<{ projects?: Record<string, string> }>("runtime.json"),
  ]);
  if (
    [
      ...Object.values(projects ?? {}),
      ...Object.values(runtime?.projects ?? {}),
    ].includes(projectId)
  )
    throw new Error(
      "The application database must not use either immutable runtime template project",
    );
}

async function saveDatabaseEnvironment(
  path: string,
  databaseUrl: string,
  projectId: string,
) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Root .env must be a regular file");
  const original = await readFile(path, "utf8");
  const existing = parse(original);
  for (const [key, value] of [
    ["DATABASE_URL", databaseUrl],
    ["FULLBEAM_INSTACLOUD_PROJECT_ID", projectId],
  ])
    if (existing[key!] && existing[key!] !== value)
      throw new Error(
        "Root .env database settings changed; reload configuration before retrying",
      );
  let updated = original;
  for (const [key, value] of [
    ["DATABASE_URL", databaseUrl],
    ["FULLBEAM_INSTACLOUD_PROJECT_ID", projectId],
  ]) {
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gm");
    const line = `${key}=${JSON.stringify(value)}`;
    updated = pattern.test(updated)
      ? updated.replace(pattern, () => line)
      : `${updated.replace(/\n?$/, "\n")}${line}\n`;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    if ((await readFile(path, "utf8")) !== original)
      throw new Error(
        "Root .env changed during database setup; retry with the updated configuration",
      );
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function setupDatabase(
  config: Config,
  dependencies: DatabaseSetupDependencies = {},
): Promise<Config> {
  const store = new EvidenceStore(config.stateDir);
  const envPath = dependencies.envPath ?? resolve(".env");
  const verify = dependencies.verify ?? verifyConnection;
  const cli = new InstacloudCli({
    apiKey: config.instacloudToken,
    orgId: config.orgId,
    openaiApiKey: config.openaiKey,
  });
  const run = dependencies.run ?? ((args, context) => cli.run(args, context));
  let databaseUrl = config.databaseUrl;
  try {
    await protectTemplates(store, config.instacloudProjectId);
    if (databaseUrl) {
      databaseAddress(databaseUrl);
      const observation = await verify(databaseUrl);
      const prior = await store.state<DatabaseReceipt>("database.json");
      await store.saveState("database.json", {
        schema_version: 1,
        project_id: config.instacloudProjectId ?? null,
        service_id:
          prior?.connection_digest === sha256(databaseUrl)
            ? prior.service_id
            : null,
        service_name:
          prior?.connection_digest === sha256(databaseUrl)
            ? prior.service_name
            : null,
        branch: "main",
        connection_digest: sha256(databaseUrl),
        connection_verified: true,
        server_version: observation.serverVersion,
        observed_at: new Date().toISOString(),
      } satisfies DatabaseReceipt);
      return config;
    }
    const projects = projectRows(
      await run(["project", "list", "--org", config.orgId, "--json"]),
    );
    let project: Project;
    if (config.instacloudProjectId) {
      const matches = projects.filter(
        (p) =>
          p.id === config.instacloudProjectId &&
          (!p.org_id || p.org_id === config.orgId),
      );
      if (matches.length !== 1)
        throw new Error(
          "Configured InstaCloud application project is unavailable in this organization",
        );
      project = matches[0]!;
    } else {
      const name = `fb-app-${digest({ org: config.orgId, repo: config.repository }).slice(0, 16)}`;
      let allocation = await store.state<DatabaseAllocation>(
        "database-allocation.json",
      );
      if (
        allocation &&
        (allocation.schema_version !== 1 ||
          allocation.org_id !== config.orgId ||
          allocation.repository !== config.repository ||
          allocation.project_name !== name)
      )
        throw new Error(
          "Database project allocation belongs to another repository or organization",
        );
      const matches = projects.filter(
        (p) => p.name === name && (!p.org_id || p.org_id === config.orgId),
      );
      if (matches.length > 1)
        throw new Error("Ambiguous database project recovery");
      if (!allocation && matches.length)
        throw new Error(
          "Existing application project has no recorded allocation intent; refusing to adopt unrelated resources",
        );
      if (
        allocation?.project_id &&
        (matches.length !== 1 || matches[0]!.id !== allocation.project_id)
      )
        throw new Error(
          "Recorded application database project is missing or changed",
        );
      allocation ??= {
        schema_version: 1,
        org_id: config.orgId,
        repository: config.repository,
        project_name: name,
      };
      await store.saveState("database-allocation.json", allocation);
      if (matches.length) project = matches[0]!;
      else {
        const created = await run([
          "project",
          "create",
          name,
          "--org",
          config.orgId,
          "--json",
        ]);
        project = created?.project;
        if (
          !project ||
          typeof project.id !== "string" ||
          project.name !== name ||
          (project.org_id && project.org_id !== config.orgId)
        )
          throw new Error(
            "InstaCloud application project creation returned mismatched identity; retry to recover its recorded intent",
          );
      }
      allocation.project_id = project.id;
      await store.saveState("database-allocation.json", allocation);
    }
    await protectTemplates(store, project.id);
    if (/^fb-(gen|verify)-/.test(project.name))
      throw new Error(
        "The application database must not use an immutable runtime template project",
      );
    const context = { projectId: project.id, branch: "main" };
    const services = await run(
      ["service", "list", "--branch", "main", "--json"],
      context,
    );
    if (
      !Array.isArray(services) ||
      services.some(
        (s) =>
          !s ||
          typeof s.id !== "string" ||
          typeof s.type !== "string" ||
          typeof s.name !== "string",
      )
    )
      throw new Error("InstaCloud service list omitted identity evidence");
    if (
      services.some(
        (s) =>
          s.type === "compute" &&
          ["runtime", "fullbeam-runtime"].includes(s.name),
      )
    )
      throw new Error(
        "Refusing to add database credentials to a benchmark runtime template",
      );
    const matches = services.filter(
      (s) => s.name === serviceName && s.type === "postgres",
    );
    if (matches.length > 1)
      throw new Error("Ambiguous application database service");
    let service = matches[0];
    if (!service)
      service = await run(
        [
          "service",
          "add",
          "postgres",
          serviceName,
          "--branch",
          "main",
          "--region",
          config.region,
          "--json",
        ],
        context,
      );
    if (
      !service ||
      typeof service.id !== "string" ||
      service.type !== "postgres" ||
      service.name !== serviceName
    )
      throw new Error(
        "InstaCloud database creation returned mismatched service identity",
      );
    const connection = await run(
      ["postgres", "url", serviceName, "--branch", "main", "--json"],
      context,
    );
    if (
      connection?.service !== serviceName ||
      connection?.branch !== "main" ||
      typeof connection?.url !== "string"
    )
      throw new Error(
        "InstaCloud database URL returned mismatched service or branch identity",
      );
    const providerAddress = databaseAddress(connection.url);
    providerAddress.searchParams.set("sslmode", "verify-full");
    databaseUrl = providerAddress.toString();
    const observation = await verify(databaseUrl!);
    await saveDatabaseEnvironment(envPath, databaseUrl!, project.id);
    await store.saveState("database.json", {
      schema_version: 1,
      project_id: project.id,
      service_id: service.id,
      service_name: serviceName,
      branch: "main",
      connection_digest: sha256(databaseUrl!),
      connection_verified: true,
      server_version: observation.serverVersion,
      observed_at: new Date().toISOString(),
    } satisfies DatabaseReceipt);
    return { ...config, databaseUrl, instacloudProjectId: project.id };
  } catch (error) {
    const secrets = [
      config.githubToken,
      config.instacloudToken,
      config.openaiKey,
      databaseUrl ?? "",
    ];
    if (databaseUrl) {
      try {
        secrets.push(decodeURIComponent(new URL(databaseUrl).password));
      } catch {
        /* URL validation has its own secret-free diagnostic. */
      }
    }
    throw new Error(
      redact(error instanceof Error ? error.message : String(error), secrets),
    );
  } finally {
    await cli.close();
  }
}
