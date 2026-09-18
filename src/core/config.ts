import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
export interface Config {
  githubToken: string;
  repository: string;
  demoRepository: string;
  instacloudToken: string;
  orgId: string;
  region: string;
  openaiKey: string;
  databaseUrl?: string;
  instacloudProjectId?: string;
  model: string;
  reasoningEffort: string;
  stateDir: string;
  rates: null | { input: number; cached: number; output: number };
  modelRates?: Record<
    string,
    { input: number; cached: number; output: number }
  >;
  maxCost: number | null;
  demoMode?: "automated" | "reviewed";
}
export const requiredSettings = [
  "FULLBEAM_GITHUB_TOKEN",
  "FULLBEAM_DEMO_REPOSITORY",
  "FULLBEAM_INSTACLOUD_API_TOKEN",
  "INSTA_ORG_ID",
  "FULLBEAM_INSTACLOUD_REGION",
  "OPENAI_API_KEY",
  "FULLBEAM_MODEL",
] as const;
export function readEnvironment(): NodeJS.ProcessEnv {
  const envPath = resolve(".env");
  return {
    ...(existsSync(envPath) ? parse(readFileSync(envPath)) : {}),
    ...process.env,
  };
}
export function missingSettings(env: NodeJS.ProcessEnv): string[] {
  return requiredSettings.filter((k) => !env[k]?.trim());
}
export function assertPublicEnvironmentTemplate(text: string): void {
  const template = parse(text);
  for (const name of [
    "FULLBEAM_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "FULLBEAM_INSTACLOUD_API_TOKEN",
    "OPENAI_API_KEY",
    "DATABASE_URL",
    "HR_API_KEY",
  ])
    if (template[name]?.trim())
      throw new Error(
        `.env.example contains a credential value for ${name}. Store it only in the ignored .env and clear the template before setup.`,
      );
}
export function loadConfig(
  env: NodeJS.ProcessEnv = readEnvironment(),
  actions = env.GITHUB_ACTIONS === "true",
): Config {
  const source = { ...env };
  if (actions) {
    source.FULLBEAM_GITHUB_TOKEN = source.GITHUB_TOKEN;
    source.FULLBEAM_DEMO_REPOSITORY ??= source.GITHUB_REPOSITORY;
    source.FULLBEAM_REPOSITORY ??= source.GITHUB_REPOSITORY;
  }
  const missing = missingSettings(source);
  if (missing.length)
    throw new Error(
      `Missing configuration: ${missing.join(", ")}. Edit the root .env; see docs/configuration.md.`,
    );
  const repo = source.FULLBEAM_REPOSITORY || source.FULLBEAM_DEMO_REPOSITORY!;
  const demo = source.FULLBEAM_DEMO_REPOSITORY!;
  for (const name of [repo, demo])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(name))
      throw new Error("Repository must be owner/name");
  const amount = (name: string): number | null => {
    if (!source[name]?.trim()) return null;
    const n = Number(source[name]);
    if (!Number.isFinite(n) || n < 0)
      throw new Error(`Invalid nonnegative number: ${name}`);
    return n;
  };
  const r = [
    amount("FULLBEAM_INPUT_USD_PER_MILLION"),
    amount("FULLBEAM_CACHED_INPUT_USD_PER_MILLION"),
    amount("FULLBEAM_OUTPUT_USD_PER_MILLION"),
  ];
  if (r.some((x) => x !== null) && r.some((x) => x === null))
    throw new Error("Configure all three model rates or leave all blank");
  const rates =
    r[0] === null ? null : { input: r[0]!, cached: r[1]!, output: r[2]! };
  const maxCost = amount("FULLBEAM_MAX_MODEL_COST_USD");
  let modelRates: Config["modelRates"];
  if (source.FULLBEAM_MODEL_RATES_JSON?.trim()) {
    try {
      const parsed = JSON.parse(source.FULLBEAM_MODEL_RATES_JSON);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      for (const [model, rate] of Object.entries(parsed)) {
        if (
          !model ||
          /\s/.test(model) ||
          !rate ||
          typeof rate !== "object" ||
          Array.isArray(rate)
        )
          throw new Error();
        const fields = rate as Record<string, unknown>;
        if (
          Object.keys(fields).sort().join(",") !== "cached,input,output" ||
          Object.values(fields).some(
            (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0,
          )
        )
          throw new Error();
      }
      modelRates = parsed;
    } catch {
      throw new Error(
        "FULLBEAM_MODEL_RATES_JSON must map exact model IDs to nonnegative input, cached, and output rates",
      );
    }
  }
  if (maxCost !== null && (!rates || maxCost <= 0))
    throw new Error(
      "A spending threshold requires all three rates and a positive limit",
    );
  const effort = source.FULLBEAM_REASONING_EFFORT || "medium";
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort))
    throw new Error("Invalid FULLBEAM_REASONING_EFFORT");
  const demoMode = source.FULLBEAM_DEMO_MODE || "automated";
  if (demoMode !== "automated" && demoMode !== "reviewed")
    throw new Error("FULLBEAM_DEMO_MODE must be automated or reviewed");
  const databaseUrl = source.DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      if (
        !["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !parsed.hostname
      )
        throw new Error();
      decodeURIComponent(parsed.password);
    } catch {
      throw new Error("DATABASE_URL must be a valid Postgres connection URL");
    }
  }
  const instacloudProjectId = source.FULLBEAM_INSTACLOUD_PROJECT_ID?.trim();
  if (instacloudProjectId && !/^[a-f0-9-]{36}$/i.test(instacloudProjectId))
    throw new Error(
      "FULLBEAM_INSTACLOUD_PROJECT_ID must be an InstaCloud project ID",
    );
  return {
    githubToken: source.FULLBEAM_GITHUB_TOKEN!,
    repository: repo,
    demoRepository: demo,
    instacloudToken: source.FULLBEAM_INSTACLOUD_API_TOKEN!,
    orgId: source.INSTA_ORG_ID!,
    region: source.FULLBEAM_INSTACLOUD_REGION!,
    openaiKey: source.OPENAI_API_KEY!,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(instacloudProjectId ? { instacloudProjectId } : {}),
    model: source.FULLBEAM_MODEL!,
    reasoningEffort: effort,
    stateDir: resolve(".fullbeam-state"),
    rates,
    ...(modelRates ? { modelRates } : {}),
    maxCost,
    demoMode,
  };
}
export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result.replace(
    /\b(?:sk-|gh[pousr]_|github_pat_|insta_)[A-Za-z0-9_-]{12,}/g,
    "[REDACTED]",
  );
}
export const secretsOf = (config: Config): string[] => [
  config.githubToken,
  config.instacloudToken,
  config.openaiKey,
  config.databaseUrl ?? "",
  ...(config.databaseUrl
    ? [decodeURIComponent(new URL(config.databaseUrl).password)]
    : []),
];
export const DEFAULT_POLICY = {
  schema_version: 1,
  attempts_per_release: 2,
  max_parallel_pipelines: 2,
  agent_timeout_seconds: 240,
  verifier_timeout_seconds: 120,
  setup_timeout_seconds: 600,
  job_timeout_minutes: 180,
  control_repeats: 2,
  allow_source_prefixes: ["src/", "tests/agent/"],
  release_decision: "NOT_QUALIFIED_FOR_PRODUCTION",
} as const;
