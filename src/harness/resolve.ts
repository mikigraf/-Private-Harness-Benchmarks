import { parse as parseToml } from "@iarna/toml";
import { parse as parseYaml } from "yaml";
import {
  digest,
  manifestDigest,
  validateBundle,
  type FileEntry,
} from "../core/integrity.js";
import { freezeRecord, type HarnessRelease } from "../core/records.js";
import { DEFAULT_POLICY } from "../core/config.js";

export const CODEX_VERSION = "0.125.0";
export const UNKNOWN_UNRESOLVED_MODEL = "UNKNOWN_UNRESOLVED";

export function isHarnessPath(path: string): boolean {
  // Controller templates and private evidence are not native harness inputs,
  // even when they contain a file named AGENTS.md.
  if (path.startsWith(".github/")) return false;
  if (path.startsWith(".fullbeam/")) return path === ".fullbeam/release.yaml";
  return (
    path === "AGENTS.md" ||
    path.endsWith("/AGENTS.md") ||
    path === "skills.md" ||
    path.startsWith(".agents/skills/") ||
    path === ".codex/config.toml"
  );
}

export interface ResolvedHarness {
  release: HarnessRelease;
  files: FileEntry[];
  settings: Record<string, unknown>;
  observations: Array<{
    path: string;
    declared: "YES";
    materialized: "YES";
    exposed: "UNKNOWN";
    observed_use: "UNKNOWN";
  }>;
}

/** A configurationError release is evidence only and must never be executed. */
export interface ComparisonResolvedHarness extends ResolvedHarness {
  configurationError: string | null;
}

export type HarnessChangeClassification =
  "MODEL_ONLY" | "HARNESS_ONLY" | "BUNDLE" | "UNCHANGED" | "UNKNOWN";

/** Compare effective model settings separately from Git-versioned harness content. */
export function classifyHarnessChange(
  current: Pick<ResolvedHarness, "files" | "settings"> & {
    configurationError?: string | null;
  },
  candidate: Pick<ResolvedHarness, "files" | "settings"> & {
    configurationError?: string | null;
  },
): HarnessChangeClassification {
  if (current.configurationError || candidate.configurationError)
    return "UNKNOWN";
  const modelKeys = new Set(["model", "model_reasoning_effort"]);
  const modelChanged = [...modelKeys].some(
    (key) => current.settings[key] !== candidate.settings[key],
  );
  const rest = (settings: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(settings).filter(([key]) => !modelKeys.has(key)),
    );
  const files = (entries: FileEntry[]) =>
    entries
      .map((file) => ({
        path: file.path,
        mode: file.mode & 0o111 ? "executable" : "regular",
        // Formatting and comments in TOML do not change effective settings.
        sha256:
          file.path === ".codex/config.toml" ? "native-settings" : file.sha256,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  const harnessChanged =
    digest(rest(current.settings)) !== digest(rest(candidate.settings)) ||
    digest(files(current.files)) !== digest(files(candidate.files));
  return modelChanged
    ? harnessChanged
      ? "BUNDLE"
      : "MODEL_ONLY"
    : harnessChanged
      ? "HARNESS_ONLY"
      : "UNCHANGED";
}

/** Validate frozen native content without creating a runtime-specific release. */
export function validateHarnessConfiguration(
  input: FileEntry[],
): Record<string, unknown> {
  return inspectConfiguration(selectHarnessFiles(input));
}

class HarnessConfigurationError extends Error {
  override readonly name = "HarnessConfigurationError";
}

export function resolveHarness(
  input: FileEntry[],
  commit: string,
  runtime: { generation: string; application: string },
  id: string,
): ResolvedHarness {
  const files = selectHarnessFiles(input);
  const settings = inspectConfiguration(files);
  return buildResolvedHarness(files, settings, null, commit, runtime, id);
}

export function resolveHarnessForComparison(
  input: FileEntry[],
  commit: string,
  runtime: { generation: string; application: string },
  id: string,
): ComparisonResolvedHarness {
  const files = selectHarnessFiles(input);
  let settings: Record<string, unknown> = {};
  let configurationError: string | null = null;
  try {
    settings = inspectConfiguration(files);
  } catch (error) {
    if (!(error instanceof HarnessConfigurationError)) throw error;
    configurationError = error.message;
    settings = bestEffortSettings(files);
  }
  return {
    ...buildResolvedHarness(
      files,
      settings,
      configurationError,
      commit,
      runtime,
      id,
    ),
    configurationError,
  };
}

function selectHarnessFiles(input: FileEntry[]): FileEntry[] {
  // Bundle corruption, duplicate paths, and unsafe modes are intake failures, not candidate choices.
  validateBundle(input);
  const files = input.filter((file) => isHarnessPath(file.path));
  validateBundle(files);
  return files;
}

function inspectConfiguration(files: FileEntry[]): Record<string, unknown> {
  const configFile = files.find((file) => file.path === ".codex/config.toml");
  if (!configFile)
    throw new HarnessConfigurationError(
      "CANDIDATE_CONFIG_ERROR: missing native Codex configuration",
    );
  let settings: Record<string, unknown>;
  try {
    const parsed = parseToml(
      Buffer.from(configFile.content, "base64").toString(),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("configuration must be a TOML table");
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    throw new HarnessConfigurationError(
      `CANDIDATE_CONFIG_ERROR: invalid native Codex configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof settings.model !== "string" || !settings.model)
    throw new HarnessConfigurationError(
      "CANDIDATE_CONFIG_ERROR: explicit model is required",
    );
  if (
    settings.approval_policy !== "never" ||
    settings.sandbox_mode !== "workspace-write" ||
    settings.web_search !== "disabled"
  ) {
    throw new HarnessConfigurationError(
      "CANDIDATE_CONFIG_ERROR: P0 requires never approvals, workspace-write sandbox and disabled search",
    );
  }
  if (
    settings.model_provider ||
    settings.model_providers ||
    settings.openai_base_url ||
    settings.mcp_servers ||
    settings.hooks ||
    settings.developer_instructions ||
    settings.model_instructions_file
  ) {
    throw new HarnessConfigurationError(
      "CANDIDATE_CONFIG_ERROR: unsupported provider/tool override",
    );
  }
  const supported = new Set([
    "model",
    "model_reasoning_effort",
    "approval_policy",
    "sandbox_mode",
    "web_search",
  ]);
  for (const key of Object.keys(settings)) {
    if (!supported.has(key))
      throw new HarnessConfigurationError(
        `CANDIDATE_CONFIG_ERROR: unsupported native setting ${key}`,
      );
  }
  if (!files.some((file) => file.path === "AGENTS.md"))
    throw new HarnessConfigurationError(
      "CANDIDATE_CONFIG_ERROR: missing AGENTS.md",
    );
  for (const file of files.filter((candidate) =>
    candidate.path.endsWith("/SKILL.md"),
  )) {
    const text = Buffer.from(file.content, "base64").toString();
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match)
      throw new HarnessConfigurationError(
        `CANDIDATE_CONFIG_ERROR: invalid native skill metadata: ${file.path}`,
      );
    try {
      const metadata = parseYaml(match[1]!);
      if (
        typeof metadata?.name !== "string" ||
        typeof metadata?.description !== "string"
      )
        throw new Error("name and description are required");
    } catch (error) {
      throw new HarnessConfigurationError(
        `CANDIDATE_CONFIG_ERROR: invalid native skill metadata: ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return settings;
}

function bestEffortSettings(files: FileEntry[]): Record<string, unknown> {
  const configFile = files.find((file) => file.path === ".codex/config.toml");
  if (!configFile) return {};
  try {
    const parsed = parseToml(
      Buffer.from(configFile.content, "base64").toString(),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildResolvedHarness(
  files: FileEntry[],
  settings: Record<string, unknown>,
  configurationError: string | null,
  commit: string,
  runtime: { generation: string; application: string },
  id: string,
): ResolvedHarness {
  const requestedModel =
    typeof settings.model === "string" && settings.model
      ? settings.model
      : UNKNOWN_UNRESOLVED_MODEL;
  const effective = {
    native: settings,
    files: manifestDigest(files),
    configuration_error: configurationError,
    isolated_home: true,
    provider: "fullbeam-proxy",
    client: CODEX_VERSION,
    required_tools: ["shell"],
    system_plugins: [],
    permissions: "workspace-write",
    agent_timeout_seconds: DEFAULT_POLICY.agent_timeout_seconds,
  };
  const release = freezeRecord<HarnessRelease>({
    kind: "HarnessRelease",
    schema_version: 1,
    id,
    source_commit: commit,
    adapter: "codex-cli",
    client_version: CODEX_VERSION,
    requested_model: requestedModel,
    reported_model: null,
    mutable_model_alias: requestedModel !== UNKNOWN_UNRESOLVED_MODEL,
    native_files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    effective_settings_sha256: digest(effective),
    tool_manifest_sha256: digest({
      required: ["shell"],
      web_search: settings.web_search ?? "UNKNOWN_UNRESOLVED",
      mcp: [],
    }),
    application_runtime_digest: runtime.application,
    generation_image_digest: runtime.generation,
    permission_policy_sha256: digest({
      approval_policy: settings.approval_policy ?? "UNKNOWN_UNRESOLVED",
      sandbox_mode: settings.sandbox_mode ?? "UNKNOWN_UNRESOLVED",
      web_search: settings.web_search ?? "UNKNOWN_UNRESOLVED",
      configuration_error: configurationError,
    }),
    agent_timeout_seconds: DEFAULT_POLICY.agent_timeout_seconds,
  });
  return {
    release,
    files,
    settings,
    observations: files.map((file) => ({
      path: file.path,
      declared: "YES",
      materialized: "YES",
      exposed: "UNKNOWN",
      observed_use: "UNKNOWN",
    })),
  };
}
