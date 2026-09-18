import { describe, expect, it } from "vitest";

import { selectDispatchedRun } from "../src/product/actions.js";
import { GitHubActions, GitHubClient } from "../src/github/index.js";

const expectedHead = "a".repeat(40);
const movedHead = "b".repeat(40);

describe("optional Actions variables", () => {
  it("clears previously configured rates and budgets and leaves already absent values unset", async () => {
    const values = new Map<string, string>([
      ["FULLBEAM_MAX_MODEL_COST_USD", "10"],
      ["FULLBEAM_INPUT_USD_PER_MILLION", "0.75"],
      ["UNRELATED_VARIABLE", "preserve"],
    ]);
    const requests: { method: string; name: string }[] = [];
    const client = new GitHubClient({
      token: "synthetic-token",
      repository: { owner: "owner", repo: "demo" },
      fetch: async (url, options) => {
        const name = new URL(String(url)).pathname.split("/").at(-1)!;
        const method = options?.method ?? "GET";
        requests.push({ method, name });
        if (method === "DELETE") {
          return new Response(null, {
            status: values.delete(name) ? 204 : 404,
          });
        }
        if (method === "GET") {
          return values.has(name)
            ? new Response(JSON.stringify({ name, value: values.get(name) }))
            : new Response(null, { status: 404 });
        }
        const body = JSON.parse(String(options?.body));
        if (body.value === "")
          return new Response(
            JSON.stringify({ message: "Variable value cannot be empty." }),
            { status: 422 },
          );
        values.set(body.name, body.value);
        return method === "POST"
          ? new Response("{}", { status: 201 })
          : new Response(null, { status: 204 });
      },
    });
    const actions = new GitHubActions(client);
    await actions.upsertVariable("FULLBEAM_MAX_MODEL_COST_USD", "");
    await actions.upsertVariable("FULLBEAM_INPUT_USD_PER_MILLION", "");
    await actions.upsertVariable("FULLBEAM_MAX_MODEL_COST_USD", "");
    expect([...values]).toEqual([["UNRELATED_VARIABLE", "preserve"]]);
    expect(requests).toEqual([
      { method: "DELETE", name: "FULLBEAM_MAX_MODEL_COST_USD" },
      { method: "DELETE", name: "FULLBEAM_INPUT_USD_PER_MILLION" },
      { method: "DELETE", name: "FULLBEAM_MAX_MODEL_COST_USD" },
    ]);
    await actions.upsertVariable("FULLBEAM_MAX_MODEL_COST_USD", "25");
    await actions.upsertVariable("FULLBEAM_MAX_MODEL_COST_USD", "30");
    expect(values.get("FULLBEAM_MAX_MODEL_COST_USD")).toBe("30");
    expect(values.get("UNRELATED_VARIABLE")).toBe("preserve");
  });

  it("does not hide authorization failures when clearing optional settings", async () => {
    const client = new GitHubClient({
      token: "synthetic-token",
      repository: { owner: "owner", repo: "demo" },
      fetch: async () => new Response(null, { status: 403 }),
    });
    await expect(
      new GitHubActions(client).upsertVariable(
        "FULLBEAM_MAX_MODEL_COST_USD",
        "",
      ),
    ).rejects.toMatchObject({ status: 403, method: "DELETE" });
  });
});

describe("workflow dispatch correlation", () => {
  it("selects the unique trigger-bound run at the expected protected commit", () => {
    const run = {
      id: 7,
      display_title: "Fullbeam compare trigger-7",
      head_sha: expectedHead,
      created_at: "2026-09-18T00:00:01Z",
      status: "queued",
      conclusion: null,
      html_url: "https://example.test/runs/7",
    };
    expect(
      selectDispatchedRun(
        [run],
        "compare",
        "trigger-7",
        expectedHead,
        Date.parse("2026-09-18T00:00:00Z"),
      ),
    ).toEqual(run);
  });

  it("fails immediately when the trigger ran at a different default-branch head", () => {
    const run = {
      id: 8,
      display_title: "Fullbeam qualify trigger-8",
      head_sha: movedHead,
      created_at: "2026-09-18T00:00:01Z",
      status: "queued",
      conclusion: null,
      html_url: "https://example.test/runs/8",
    };
    expect(() =>
      selectDispatchedRun(
        [run],
        "qualify",
        "trigger-8",
        expectedHead,
        Date.parse("2026-09-18T00:00:00Z"),
      ),
    ).toThrow(/different protected commit|default branch moved/i);
  });
});
