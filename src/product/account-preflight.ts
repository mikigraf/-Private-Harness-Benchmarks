import type { Config } from "../core/config.js";

/** Read-only checks before bootstrap can allocate paid runtime resources. */
export async function checkBootstrapAccounts(
  config: Pick<Config, "githubToken" | "openaiKey" | "model">,
  fetcher: typeof fetch = fetch,
): Promise<{ actor: string; githubScopes: string[] | null; model: string }> {
  const github = await fetcher("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!github.ok) {
    await github.body?.cancel();
    throw new Error(`GitHub authentication failed: HTTP ${github.status}`);
  }
  const scopesHeader = github.headers.get("x-oauth-scopes");
  const githubScopes =
    scopesHeader === null
      ? null
      : scopesHeader.split(",").map((scope) => scope.trim());
  const actor = (await github.json()) as { login?: string };
  if (!actor.login)
    throw new Error("GitHub did not return an authenticated account");
  if (
    githubScopes &&
    (!githubScopes.includes("repo") || !githubScopes.includes("workflow"))
  )
    throw new Error(
      "GitHub bootstrap requires repo and workflow scopes. Update FULLBEAM_GITHUB_TOKEN in .env, or authorize gh auth refresh --scopes repo,workflow and copy the refreshed token securely.",
    );
  const model = await fetcher(
    `https://api.openai.com/v1/models/${encodeURIComponent(config.model)}`,
    {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    },
  );
  if (!model.ok) {
    await model.body?.cancel();
    throw new Error(
      `OpenAI model access failed: HTTP ${model.status}. Check OPENAI_API_KEY and FULLBEAM_MODEL in .env.`,
    );
  }
  await model.body?.cancel();
  return { actor: actor.login, githubScopes, model: config.model };
}
