import { describe, expect, it } from "vitest";
import { checkBootstrapAccounts } from "../src/product/account-preflight.js";

const config = {
  githubToken: "synthetic-github",
  openaiKey: "synthetic-openai",
  model: "test-model",
};

describe("bootstrap account preflight", () => {
  it("stops missing workflow scope before model checks or resource provisioning", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ login: "operator" }), {
        headers: { "x-oauth-scopes": "repo, read:org" },
      });
    };
    await expect(
      checkBootstrapAccounts(config, fetcher as typeof fetch),
    ).rejects.toThrow(/workflow/);
    expect(calls).toEqual(["https://api.github.com/user"]);
  });

  it("checks a configured model without exposing rejected provider bodies or keys", async () => {
    const fetcher = async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? new Response(JSON.stringify({ login: "operator" }), {
            headers: { "x-oauth-scopes": "repo, workflow" },
          })
        : new Response("synthetic-openai secret backend body", { status: 401 });
    await expect(
      checkBootstrapAccounts(config, fetcher as typeof fetch),
    ).rejects.toThrow("OpenAI model access failed: HTTP 401");
  });

  it("accepts fine-grained tokens without inferring scopes the server did not report", async () => {
    const fetcher = async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes("api.github.com")
            ? { login: "operator" }
            : { id: "test-model" },
        ),
      );
    await expect(
      checkBootstrapAccounts(config, fetcher as typeof fetch),
    ).resolves.toEqual({
      actor: "operator",
      githubScopes: null,
      model: "test-model",
    });
  });
});
