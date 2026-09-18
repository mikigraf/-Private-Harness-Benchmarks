import {
  GitHubClient,
  GitHubBootstrap,
  GitHubActions,
} from "../github/index.js";
import type { Config } from "../core/config.js";
import { sha256, makeFile } from "../core/integrity.js";
export function github(
  config: Config,
  repository = config.repository,
  id?: number,
) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("Invalid repository");
  return new GitHubClient({
    token: config.githubToken,
    repository: { owner, repo, repositoryId: id },
  });
}
export async function readRepoJson<T>(
  client: GitHubClient,
  path: string,
  ref: string,
): Promise<T> {
  const f = await client.rest<{ encoding: string; content: string }>(
    "GET",
    `contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (f.encoding !== "base64") throw new Error("Repository JSON not available");
  return JSON.parse(
    Buffer.from(f.content.replace(/\s/g, ""), "base64").toString(),
  ) as T;
}
export async function defaultHead(
  client: GitHubClient,
): Promise<{ id: number; branch: string; sha: string; private: boolean }> {
  const r = await client.rest<{
    id: number;
    default_branch: string;
    private: boolean;
  }>("GET", "");
  const ref = await client.rest<{ object: { sha: string } }>(
    "GET",
    `git/ref/heads/${encodeURIComponent(r.default_branch)}`,
  );
  return {
    id: r.id,
    branch: r.default_branch,
    sha: ref.object.sha,
    private: r.private,
  };
}
export async function commitJson(
  client: GitHubClient,
  path: string,
  value: unknown,
  message: string,
): Promise<string> {
  const head = await defaultHead(client);
  const r = await new GitHubBootstrap(client).commitFiles({
    branch: head.branch,
    baseCommitSha: head.sha,
    message,
    files: [{ path, content: JSON.stringify(value, null, 2) + "\n" }],
  });
  return r.commitSha;
}
export async function configureActions(
  client: GitHubClient,
  config: Config,
): Promise<void> {
  const actions = new GitHubActions(client);
  await actions.putSecret(
    "FULLBEAM_INSTACLOUD_API_TOKEN",
    config.instacloudToken,
  );
  await actions.putSecret("OPENAI_API_KEY", config.openaiKey);
  const values: Record<string, string> = {
    INSTA_ORG_ID: config.orgId,
    FULLBEAM_INSTACLOUD_REGION: config.region,
    FULLBEAM_MODEL: config.model,
    FULLBEAM_REASONING_EFFORT: config.reasoningEffort,
    FULLBEAM_INPUT_USD_PER_MILLION: config.rates
      ? String(config.rates.input)
      : "",
    FULLBEAM_CACHED_INPUT_USD_PER_MILLION: config.rates
      ? String(config.rates.cached)
      : "",
    FULLBEAM_OUTPUT_USD_PER_MILLION: config.rates
      ? String(config.rates.output)
      : "",
    FULLBEAM_MAX_MODEL_COST_USD:
      config.maxCost === null ? "" : String(config.maxCost),
    FULLBEAM_MODEL_RATES_JSON: config.modelRates
      ? JSON.stringify(config.modelRates)
      : "",
  };
  for (const [name, value] of Object.entries(values))
    await actions.upsertVariable(name, value);
}
