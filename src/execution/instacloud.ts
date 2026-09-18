import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  FileBundle,
  EnvironmentRef,
  EnvironmentSpec,
  AttemptInput,
  RemoteExecutionRef,
  ExecutionStatus,
  ArtifactManifest,
  ExecutorOptions,
  CapabilityReport,
  Role,
} from "./types.js";
export type * from "./types.js";
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const INSTA_CLI_VERSION = "0.1.0";
const MAX_BUNDLE = 8 * 1024 * 1024,
  MAX_FILE = 1024 * 1024,
  CHUNK = 24 * 1024;
export function branchName(id: string): string {
  return `fullbeam-${digest(id).slice(0, 30)}`;
}

export function createNativeToolProbe(nonce: string) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(nonce))
    throw new Error("Invalid native tool probe nonce");
  const input = JSON.stringify({ nonce }) + "\n";
  const script = `const fs = require("node:fs");
const { createHash } = require("node:crypto");
const input = fs.readFileSync("probe-input.json");
const { nonce } = JSON.parse(input.toString());
const receipt = { nonce, input_sha256: createHash("sha256").update(input).digest("hex") };
fs.writeFileSync("probe-receipt.json", JSON.stringify(receipt) + "\\n");
process.stdout.write("FULLBEAM_NATIVE_TOOL_OK " + receipt.nonce + " " + receipt.input_sha256 + "\\n");
`;
  const bundle: FileBundle = {
    files: [
      ["fullbeam-probe.cjs", script],
      ["probe-input.json", input],
      ["probe-receipt.json", "null\n"],
    ].map(([path, content]) => ({
      path: path!,
      content: Buffer.from(content!).toString("base64"),
      size: Buffer.byteLength(content!),
      sha256: digest(content!),
      mode: 0o100644,
    })),
  };
  return {
    nonce,
    inputSha256: digest(input),
    bundle,
    prompt:
      "This is a native terminal capability probe. From the workspace, use your terminal tool to run exactly: node fullbeam-probe.cjs. The script reads the probe input and updates the already-declared probe-receipt.json. Do not synthesize the receipt yourself, change any other file, or merely describe the command. After the command succeeds, reply OK.",
  };
}

export function verifyNativeToolProbe(
  result: ArtifactManifest,
  probe: ReturnType<typeof createNativeToolProbe>,
) {
  if (
    result.role !== "generation" ||
    result.status !== "COMPLETED" ||
    result.exitCode !== 0 ||
    !result.integrityVerified ||
    result.violations.length ||
    result.logsTruncated ||
    result.effectiveNativeSettings?.status !== "VERIFIED"
  )
    throw new Error(
      "Native model/tool probe lacks successful, policy-clean execution evidence",
    );
  validateBundle({ files: result.files });
  const manifest = (files: FileBundle["files"]) =>
    files
      .map(({ content: _, ...file }) => file)
      .sort((left, right) => left.path.localeCompare(right.path));
  const sorted = (files: ArtifactManifest["beforeManifest"]) =>
    [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (
    canonical(sorted(result.beforeManifest)) !==
      canonical(manifest(probe.bundle.files)) ||
    canonical(sorted(result.afterManifest)) !==
      canonical(manifest(result.files)) ||
    result.files.length !== probe.bundle.files.length ||
    result.files.some(
      (file) =>
        !probe.bundle.files.some((expected) => expected.path === file.path),
    ) ||
    probe.bundle.files.some(
      (expected) =>
        expected.path !== "probe-receipt.json" &&
        !result.files.some(
          (file) =>
            file.path === expected.path &&
            file.sha256 === expected.sha256 &&
            file.mode === expected.mode,
        ),
    )
  )
    throw new Error(
      "Native tool probe changed or omitted declared/protected files",
    );
  const receiptFile = result.files.find(
    (file) => file.path === "probe-receipt.json",
  );
  if (!receiptFile || receiptFile.mode !== 0o100644)
    throw new Error("Native tool probe receipt is missing or has invalid mode");
  let receipt: unknown;
  let events: any[];
  try {
    receipt = JSON.parse(Buffer.from(receiptFile.content, "base64").toString());
    events = result.events
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error(
      "Native tool probe receipt or native command trace is malformed",
    );
  }
  if (
    canonical(receipt) !==
    canonical({ nonce: probe.nonce, input_sha256: probe.inputSha256 })
  )
    throw new Error(
      "Native tool probe receipt does not match the input nonce and digest",
    );
  const marker = `FULLBEAM_NATIVE_TOOL_OK ${probe.nonce} ${probe.inputSha256}`;
  const completed = events.some(
    (event) =>
      event?.type === "item.completed" &&
      event.item?.type === "command_execution" &&
      event.item.status === "completed" &&
      event.item.exit_code === 0 &&
      typeof event.item.command === "string" &&
      /(?:^|[\s'"])node\s+fullbeam-probe\.cjs(?:$|[\s'"])/.test(
        event.item.command,
      ) &&
      typeof event.item.aggregated_output === "string" &&
      event.item.aggregated_output.split(/\r?\n/).includes(marker),
  );
  if (!completed)
    throw new Error(
      "Native tool probe lacks a successful nonce-bound native terminal event",
    );
  return {
    status: "VERIFIED" as const,
    command: "node fullbeam-probe.cjs",
    nonce: probe.nonce,
    inputSha256: probe.inputSha256,
    receiptSha256: receiptFile.sha256,
  };
}
export function validateBundle(bundle: FileBundle): FileBundle {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length > 2048)
    throw new Error("Invalid file bundle limit");
  let size = 0;
  const paths = new Set<string>();
  for (const f of bundle.files) {
    if (
      typeof f.path !== "string" ||
      !f.path ||
      f.path.length > 240 ||
      f.path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(f.path) ||
      f.path.startsWith("/") ||
      /^[A-Za-z]:/.test(f.path) ||
      f.path
        .split("/")
        .some(
          (s) =>
            !s ||
            s === "." ||
            s === ".." ||
            s === ".git" ||
            s === "node_modules",
        )
    )
      throw new Error("Unsafe bundle path");
    if (paths.has(f.path)) throw new Error("duplicate bundle path");
    paths.add(f.path);
    if (![0o100644, 0o100755].includes(f.mode))
      throw new Error("Unsupported file mode");
    if (
      typeof f.content !== "string" ||
      Buffer.from(f.content, "base64").toString("base64") !== f.content
    )
      throw new Error("Noncanonical base64");
    const bytes = Buffer.from(f.content, "base64");
    size += bytes.length;
    if (bytes.length !== f.size || bytes.length > MAX_FILE || size > MAX_BUNDLE)
      throw new Error("File size or bundle limit exceeded");
    if (digest(bytes) !== f.sha256) throw new Error("File digest mismatch");
  }
  for (const p of paths)
    for (const other of paths)
      if (other.startsWith(`${p}/`))
        throw new Error("File/directory path collision");
  return bundle;
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected provider response");
  return value as Record<string, any>;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** Runs the supported CLI in explicit agent mode. Local credentials and enrolled
 * project sessions live only in isolated temporary directories, never the caller's
 * linked project. Durable agent keys need no session; the CLI decides that after
 * verifying /me. User API keys enroll through the official project-link command. */
export class InstacloudCli {
  private home?: string;
  private authenticated = false;
  private linkedProjects = new Set<string>();
  constructor(
    readonly options: Pick<
      ExecutorOptions,
      "apiKey" | "orgId" | "cliPath" | "openaiApiKey" | "operationDeadline"
    >,
  ) {}
  operationTimeout(maximum: number): number {
    const deadline = this.options.operationDeadline?.();
    if (deadline === undefined) return maximum;
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new Error("Remote operation deadline exceeded");
    return Math.min(maximum, Math.max(1, Math.floor(remaining)));
  }
  redact(text: string): string {
    for (const secret of [this.options.apiKey, this.options.openaiApiKey])
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, 2000);
  }
  async run(
    args: string[],
    context: { projectId?: string; branch?: string } = {},
  ): Promise<unknown> {
    this.operationTimeout(args[0] === "deploy" ? 900_000 : 120_000);
    if (!this.home)
      this.home = await mkdtemp(join(tmpdir(), "fullbeam-insta-"));
    const work = join(
      this.home,
      context.projectId ? `project-${digest(context.projectId)}` : "bootstrap",
    );
    await mkdir(work, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      INSTA_ENV: "prod",
      INSTA_NO_AUTOUPDATE: "1",
      INSTA_ORG_ID: this.options.orgId,
      INSTA_PROJECT_ID: context.projectId,
      INSTA_BRANCH: context.branch ?? "main",
      CI: "1",
      NO_COLOR: "1",
    };
    const invoke = (argv: string[]) =>
      new Promise<string>((res, rej) =>
        execFile(
          this.options.cliPath ?? resolve("node_modules/.bin/insta"),
          ["--agent", ...argv],
          {
            cwd: work,
            env,
            timeout: this.operationTimeout(
              argv[0] === "deploy" ? 900_000 : 120_000,
            ),
            maxBuffer: 3 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error)
              rej(
                new Error(
                  `Instacloud command failed (${argv[0]} ${argv[1] ?? ""}, exit ${error.code ?? "unknown"}): ${this.redact(stderr || stdout)}`,
                ),
              );
            else res(stdout);
          },
        ),
      );
    if (!this.authenticated) {
      if (!this.options.apiKey)
        throw new Error("FULLBEAM_INSTACLOUD_API_TOKEN is required");
      await invoke(["login", "--api-key", this.options.apiKey]);
      this.authenticated = true;
    }
    if (context.projectId && !this.linkedProjects.has(context.projectId)) {
      const linked = object(
        JSON.parse(
          await invoke(["project", "link", context.projectId, "--json"]),
        ),
      );
      if (linked.project?.id !== context.projectId)
        throw new Error(
          "Instacloud project link returned a mismatched identity",
        );
      this.linkedProjects.add(context.projectId);
    }
    const stdout = await invoke(args);
    try {
      return JSON.parse(stdout);
    } catch {
      if (args[0] === "--version") return stdout.trim();
      throw new Error("Instacloud returned non-JSON output");
    }
  }
  async close(): Promise<void> {
    if (this.home) await rm(this.home, { recursive: true, force: true });
    this.home = undefined;
    this.authenticated = false;
    this.linkedProjects.clear();
  }
}
export class InstacloudExecutor {
  private readonly cli: InstacloudCli;
  constructor(readonly options: ExecutorOptions) {
    if (options.generationProjectId === options.verifierProjectId)
      throw new Error("Separate generation and verifier projects required");
    this.cli = new InstacloudCli(options);
  }
  private async run(
    args: string[],
    context: { projectId?: string; branch?: string } = {},
  ): Promise<unknown> {
    this.cli.operationTimeout(args[0] === "deploy" ? 900_000 : 120_000);
    return this.options.transport
      ? this.options.transport(args, context)
      : this.cli.run(args, context);
  }
  private redact(text: string): string {
    return this.cli.redact(text);
  }
  async close(): Promise<void> {
    await this.cli.close();
  }
  async createAttemptEnvironment(
    spec: EnvironmentSpec,
  ): Promise<EnvironmentRef> {
    if (
      !this.options.onEnvironmentIntent ||
      !this.options.onEnvironmentAllocated
    )
      throw new Error("Durable journal registration hooks are required");
    if (!spec.id || !["generation", "verification"].includes(spec.role))
      throw new Error("Invalid environment spec");
    const env: EnvironmentRef = {
      ...spec,
      projectId:
        spec.role === "generation"
          ? this.options.generationProjectId
          : this.options.verifierProjectId,
      branch: branchName(spec.id),
    };
    await this.options.onEnvironmentIntent(env);
    const result = object(
      await this.run(
        ["branch", "create", env.branch, "--from", "main", "--json"],
        env,
      ),
    );
    const branch = object(result.branch);
    if (branch.name !== env.branch || typeof branch.id !== "string")
      throw new Error("Allocated branch identity missing/mismatched");
    env.providerId = branch.id;
    await this.options.onEnvironmentAllocated(env);
    await this.assertRuntimeIdentity(env);
    // Branch creation records the cloned service before its machine is ready.
    // Explicitly wake it and verify the supervisor endpoint before the first exec.
    const started = object(
      await this.run(
        ["compute", "start", "runtime", "--branch", env.branch, "--json"],
        env,
      ),
    );
    if (
      started.service?.name !== "runtime" ||
      started.service?.image !== this.options.runtimeImages?.[env.role] ||
      typeof started.service?.domain !== "string" ||
      !/^[a-z0-9.-]+$/i.test(started.service.domain)
    )
      throw new Error("Started runtime identity or endpoint was not confirmed");
    await this.confirmDeployment(`https://${started.service.domain}`);
    await this.assertRuntimeIdentity(env);
    return env;
  }
  private async assertRuntimeIdentity(env: EnvironmentRef): Promise<void> {
    const expected = this.options.runtimeImages?.[env.role];
    if (!expected || !/@sha256:[a-f0-9]{64}$/.test(expected))
      throw new Error("Immutable runtime image is not configured");
    const rows = await this.run(
      ["service", "list", "--branch", env.branch, "--json"],
      env,
    );
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0].type !== "compute" ||
      rows[0].name !== "runtime" ||
      rows[0].image !== expected
    )
      throw new Error(
        "Allocated runtime image does not match the pinned template",
      );
    if (rows[0].always_on !== true)
      throw new Error("Allocated runtime is not confirmed always-on");
  }
  private async assertCleanTemplate(projectId: string): Promise<void> {
    const secrets = object(
      await this.run(["secrets", "list", "--branch", "main", "--json"], {
        projectId,
      }),
    );
    if (
      !Array.isArray(secrets.projectWide) ||
      !secrets.branch ||
      !Array.isArray(secrets.branch.unbound) ||
      !Array.isArray(secrets.branch.services)
    )
      throw new Error("Template secret inventory unavailable");
    if (
      secrets.projectWide.length ||
      secrets.branch.unbound.length ||
      secrets.branch.services.some(
        (s: any) => !Array.isArray(s.secrets) || s.secrets.length,
      )
    )
      throw new Error("Template project contains inherited secrets");
  }
  private assertEnvironment(env: EnvironmentRef) {
    const expected =
      env.role === "generation"
        ? this.options.generationProjectId
        : this.options.verifierProjectId;
    if (env.projectId !== expected || env.branch !== branchName(env.id))
      throw new Error("Refusing resource outside recorded Fullbeam identity");
  }
  private async command(
    env: EnvironmentRef,
    verb: string,
    ...args: string[]
  ): Promise<any> {
    this.assertEnvironment(env);
    const result = object(
      await this.run(
        [
          "compute",
          "exec",
          "runtime",
          "--branch",
          env.branch,
          "--timeout",
          "30",
          "--json",
          "--",
          "node",
          "/opt/fullbeam/supervisor.mjs",
          verb,
          ...args,
        ],
        env,
      ),
    );
    if (
      result.exitCode !== 0 ||
      result.truncated ||
      typeof result.stdout !== "string"
    )
      throw new Error(`Remote supervisor ${verb} failed or truncated`);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`Invalid supervisor ${verb} response`);
    }
  }
  private async transfer(
    env: EnvironmentRef,
    kind: string,
    value: unknown,
  ): Promise<string> {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > 16 * 1024 * 1024)
      throw new Error("Transport limit exceeded");
    const id = digest(data);
    await this.command(env, "upload-begin", id, String(data.length), kind);
    for (let offset = 0; offset < data.length; offset += CHUNK)
      await this.command(
        env,
        "upload-chunk",
        id,
        String(offset),
        data.subarray(offset, offset + CHUNK).toString("base64"),
      );
    await this.command(env, "upload-finish", id);
    return id;
  }
  async putBundle(env: EnvironmentRef, bundle: FileBundle): Promise<void> {
    validateBundle(bundle);
    const id = await this.transfer(env, "bundle", bundle);
    const result = await this.command(env, "materialize", id);
    if (result.digest !== digest(JSON.stringify(bundle)))
      throw new Error("Roundtrip bundle digest mismatch");
  }
  async start(
    env: EnvironmentRef,
    input: AttemptInput,
  ): Promise<RemoteExecutionRef> {
    if (input.role !== env.role)
      throw new Error("Attempt role does not match template");
    if (
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > 3600
    )
      throw new Error("Attempt time budget must be 1–3600 seconds");
    if (
      input.role === "generation" &&
      (!input.model || !this.options.openaiApiKey)
    )
      throw new Error(
        "Generation requires explicit model and OpenAI credential",
      );
    const id = await this.transfer(env, "input", {
      ...input,
      ...(input.role === "generation"
        ? { modelApiKey: this.options.openaiApiKey }
        : {}),
    });
    const result = await this.command(env, "start", id);
    if (typeof result.executionId !== "string")
      throw new Error("Missing remote execution identity");
    return { environment: env, executionId: result.executionId };
  }
  async poll(ref: RemoteExecutionRef): Promise<ExecutionStatus> {
    return await this.command(ref.environment, "status", ref.executionId);
  }
  async collect(ref: RemoteExecutionRef): Promise<ArtifactManifest> {
    const meta = await this.command(
      ref.environment,
      "collect",
      ref.executionId,
    );
    if (
      !Number.isInteger(meta.size) ||
      meta.size < 1 ||
      meta.size > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(meta.sha256)
    )
      throw new Error("Invalid artifact metadata");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < meta.size; offset += CHUNK) {
      const part = await this.command(
        ref.environment,
        "read-artifact",
        ref.executionId,
        String(offset),
        String(CHUNK),
      );
      const b = Buffer.from(part.content, "base64");
      if (b.length !== Math.min(CHUNK, meta.size - offset))
        throw new Error("Artifact chunk size mismatch");
      chunks.push(b);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== meta.sha256)
      throw new Error("Collected artifact digest mismatch");
    const result = JSON.parse(bytes.toString()) as ArtifactManifest;
    if (result.executionId !== ref.executionId)
      throw new Error("Artifact execution mismatch");
    validateBundle({ files: result.files });
    return result;
  }
  async destroy(env: EnvironmentRef): Promise<void> {
    this.assertEnvironment(env);
    const existing = await this.run(["branch", "list", "--json"], env);
    if (!Array.isArray(existing)) throw new Error("Invalid branch list");
    if (existing.some((b) => b.name === env.branch)) {
      await this.run(["branch", "delete", env.branch, "--json"], env);
      const after = await this.run(["branch", "list", "--json"], env);
      if (!Array.isArray(after) || after.some((b) => b.name === env.branch))
        throw new Error("Fullbeam environment still exists after delete");
    }
  }
  private async confirmDeployment(url: unknown): Promise<void> {
    if (typeof url !== "string" || !url.startsWith("https://"))
      throw new Error("Deployment did not return a secure runtime URL");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      this.cli.operationTimeout(5000);
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(
            this.cli.operationTimeout(
              Math.min(5000, Math.max(1, deadline - Date.now())),
            ),
          ),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            service?: string;
            ready?: boolean;
          };
          if (body.service === "fullbeam-runtime" && body.ready === true)
            return;
        } else await response.body?.cancel();
      } catch {
        /* The newly deployed endpoint may not be routed yet. */
      }
      const remaining = deadline - Date.now();
      if (remaining > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2000, remaining)),
        );
    }
    throw new Error(
      "Deployed runtime endpoint did not become ready within 60 seconds",
    );
  }
  async provisionTemplates(runtimeRoot: string): Promise<Record<Role, string>> {
    const images = {} as Record<Role, string>;
    for (const role of ["generation", "verification"] as const) {
      const projectId =
        role === "generation"
          ? this.options.generationProjectId
          : this.options.verifierProjectId;
      await this.assertCleanTemplate(projectId);
      const services = await this.run(["service", "list", "--json"], {
        projectId,
      });
      const rows = Array.isArray(services)
        ? services
        : object(services).services;
      if (
        !Array.isArray(rows) ||
        rows.some((s: any) => s.type !== "compute" || s.name !== "runtime")
      )
        throw new Error(
          "Template project must contain only the trusted runtime service",
        );
      if (rows[0]?.image) {
        if (
          typeof rows[0].image !== "string" ||
          !/@sha256:[a-f0-9]{64}$/.test(rows[0].image) ||
          rows[0].always_on !== true
        )
          throw new Error(
            "Existing template lacks immutable image/always-on evidence; refusing redeployment",
          );
        images[role] = rows[0].image;
        continue;
      }
      if (!rows.length)
        await this.run(
          [
            "service",
            "add",
            "compute",
            "runtime",
            "--region",
            this.options.region ?? "us-east",
            "--always-on",
            "--json",
          ],
          { projectId },
        );
      const awake = object(
        await this.run(["compute", "always-on", "on", "runtime", "--json"], {
          projectId,
        }),
      );
      if (awake.service?.always_on !== true)
        throw new Error("Template always-on state was not confirmed");
      const out = object(
        await this.run(
          ["deploy", resolve(runtimeRoot), "--group", "runtime", "--json"],
          { projectId },
        ),
      );
      if (
        typeof out.image !== "string" ||
        !/@sha256:[a-f0-9]{64}$/.test(out.image)
      )
        throw new Error(
          "Provider did not resolve immutable runtime image digest; pin the deployment before running",
        );
      await this.confirmDeployment(out.url);
      images[role] = out.image;
    }
    this.options.runtimeImages = images;
    return images;
  }
  private async discoverSchemas(): Promise<{
    snapshot: unknown;
    hash: string;
  }> {
    if (!this.options.apiKey)
      throw new Error(
        "Authenticated MCP schema discovery requires Instacloud key",
      );
    let session: string | undefined;
    const rpc = async (method: string, params: unknown, id?: number) => {
      const response = await fetch("https://mcp.instacloud.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session ? { "Mcp-Session-Id": session } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id ? { id } : {}),
          method,
          params,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `Authenticated MCP ${method} failed: HTTP ${response.status}`,
        );
      session = response.headers.get("mcp-session-id") ?? session;
      const text = await response.text();
      if (id === undefined) return null;
      const messages = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      const value = messages.find((m) => m.id === id);
      if (!value || value.error)
        throw new Error(`MCP ${method} returned error/no result`);
      return value.result;
    };
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fullbeam", version: "0.1.0" },
      },
      1,
    );
    await rpc("notifications/initialized", {});
    const schemas: any[] = [];
    let cursor: string | undefined;
    do {
      const result = await rpc("tools/list", cursor ? { cursor } : {}, 2);
      if (!Array.isArray(result.tools))
        throw new Error("MCP tools/list missing schemas");
      schemas.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    for (const target of ["project", "branch", "deploy", "exec"])
      if (
        !schemas.some(
          (t) => typeof t.name === "string" && t.name.includes(target),
        )
      )
        throw new Error(`MCP schema discovery missing ${target} capability`);
    return { snapshot: schemas, hash: digest(canonical(schemas)) };
  }
  async preflight(): Promise<CapabilityReport> {
    const report: CapabilityReport = {
      status: "BLOCKED",
      checkedAt: new Date().toISOString(),
      region: this.options.region ?? "us-east",
      observations: {
        egressRestrictions: "UNKNOWN",
        billingGranularity: "UNKNOWN",
        providerTTL: "UNKNOWN",
        remoteCommandTimeoutSeconds: 30,
        documentedOutputCapBytes: 1048576,
      },
      blockers: [],
    };
    const environments: EnvironmentRef[] = [];
    try {
      report.cliVersion = String(await this.run(["--version"]));
      if (report.cliVersion !== INSTA_CLI_VERSION)
        throw new Error(`Pinned insta ${INSTA_CLI_VERSION} required`);
      const schemas = await this.discoverSchemas();
      report.schemaSnapshot = schemas.snapshot;
      report.schemaHash = schemas.hash;
      if (
        !this.options.runtimeImages ||
        Object.values(this.options.runtimeImages).some(
          (v) => !/@sha256:[a-f0-9]{64}$/.test(v),
        )
      )
        throw new Error(
          "Both deployed immutable runtime image digests are required",
        );
      report.runtimeImages = this.options.runtimeImages;
      for (const project of [
        this.options.generationProjectId,
        this.options.verifierProjectId,
      ])
        await this.assertCleanTemplate(project);
      const nonce = randomUUID();
      for (const role of ["generation", "verification"] as const) {
        const env = await this.createAttemptEnvironment({
          id: `preflight-${nonce}-${role}`,
          role,
        });
        environments.push(env);
        const observation = await this.command(env, "probe", role);
        report.observations[role] = observation;
        if (observation.nativeConfigVerified !== true)
          throw new Error(
            `${role} mandatory native configuration/skill discovery probe failed`,
          );
        if (!observation.cleanTemplate || !observation.credentialIsolation)
          throw new Error(`${role} mandatory runtime isolation probe failed`);
        if (!observation.nativeSandbox)
          throw new Error(
            `${role} mandatory native sandbox probe failed: ${
              typeof observation.sandboxError === "string" &&
              observation.sandboxError.trim()
                ? this.redact(observation.sandboxError.trim())
                : "runtime supplied no sandbox diagnostic"
            }`,
          );
      }
      report.observations.concurrentEnvironments = environments.length;
      const env = environments[0]!;
      const bytes = Buffer.from("Fullbeam authenticated transfer probe\n");
      await this.putBundle(env, {
        files: [
          {
            path: "probe.txt",
            content: bytes.toString("base64"),
            size: bytes.length,
            sha256: digest(bytes),
            mode: 0o100644,
          },
        ],
      });
      const probe = await this.command(env, "start-probe");
      let status = await this.command(env, "status", probe.executionId);
      const deadline = Date.now() + 30_000;
      while (status.state === "RUNNING" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        status = await this.command(env, "status", probe.executionId);
      }
      if (status.state !== "COMPLETED")
        throw new Error("Detached execution did not complete");
      const artifact = await this.collect({
        environment: env,
        executionId: probe.executionId,
      });
      if (!artifact.integrityVerified)
        throw new Error("Detached artifact integrity failed");
      report.observations.detachedExecution = "VERIFIED";
      if (!this.options.model || !this.options.openaiApiKey)
        throw new Error(
          "Explicit model and OpenAI key required for native model capability probe",
        );
      const modelEnvironment = await this.createAttemptEnvironment({
        id: `preflight-${nonce}-native-model`,
        role: "generation",
      });
      environments.push(modelEnvironment);
      const toolProbe = createNativeToolProbe(nonce);
      await this.putBundle(modelEnvironment, toolProbe.bundle);
      const nativeRef = await this.start(modelEnvironment, {
        role: "generation",
        model: this.options.model,
        capabilityProbe: true,
        prompt: toolProbe.prompt,
        timeoutSeconds: 120,
        allowedWritePaths: ["probe-receipt.json"],
        protectedPaths: ["fullbeam-probe.cjs", "probe-input.json"],
      });
      let nativeStatus = await this.poll(nativeRef);
      const nativeDeadline = Date.now() + 150_000;
      while (nativeStatus.state === "RUNNING" && Date.now() < nativeDeadline) {
        await new Promise((r) => setTimeout(r, 1500));
        nativeStatus = await this.poll(nativeRef);
      }
      const nativeObservation: Record<string, unknown> = {
        status: "OBSERVED",
        model: this.options.model,
        executionStatus: nativeStatus,
      };
      report.observations.nativeModelProxy = nativeObservation;
      try {
        if (!["COMPLETED", "FAILED"].includes(nativeStatus.state))
          throw new Error(
            "Native model/proxy capability probe did not complete",
          );
        // Preserve the captured artifact before evaluating it: cleanup destroys
        // the disposable environment even when native execution or tool proof fails.
        const nativeResult = await this.collect(nativeRef);
        Object.assign(nativeObservation, {
          nativeVersion: nativeResult.nativeVersion ?? null,
          usage: nativeResult.usage,
          artifact: nativeResult,
        });
        report.observations.nativeToolExecution = verifyNativeToolProbe(
          nativeResult,
          toolProbe,
        );
        nativeObservation.status = "VERIFIED";
      } catch (error) {
        nativeObservation.status = "FAILED";
        report.observations.nativeToolExecution = {
          status: "FAILED",
          reason: this.redact(String(error)),
        };
        throw error;
      }
    } catch (error) {
      report.blockers.push(this.redact(String(error)));
    } finally {
      for (const env of environments)
        try {
          await this.destroy(env);
        } catch (error) {
          report.blockers.push(`Cleanup failed: ${this.redact(String(error))}`);
        }
    }
    report.observations.deletionConfirmed = report.blockers.every(
      (b) => !b.startsWith("Cleanup failed"),
    );
    report.status = report.blockers.length ? "BLOCKED" : "READY";
    return report;
  }
}
