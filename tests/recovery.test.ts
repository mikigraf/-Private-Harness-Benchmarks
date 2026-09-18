import { it, expect } from "vitest";
import { recover } from "../src/product/recovery.js";
it("does not claim successful cleanup when required remote journal artifacts expired", async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/contents/"))
      return Response.json({
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            projects: { generation: "g", verification: "v" },
            images: { generation: "image", verification: "image" },
          }),
        ).toString("base64"),
      });
    if (url.endsWith("/artifacts?per_page=100"))
      return Response.json({
        artifacts: [
          { id: 1, name: "fb-resource-synthetic-0-aaaaaaaaaa", expired: true },
        ],
      });
    if (url.endsWith("/actions/runs/123"))
      return Response.json({
        repository: { full_name: "owned/demo" },
        head_sha: "a".repeat(40),
        event: "workflow_dispatch",
        status: "completed",
        path: ".github/workflows/fullbeam-compare.yml",
      });
    throw new Error("Unexpected provider request: " + url);
  };
  await expect(
    recover(
      {
        githubToken: "synthetic",
        repository: "owned/demo",
        instacloudToken: "synthetic",
        orgId: "org",
        region: "ams",
        stateDir: "/not-written",
      },
      123,
      { fetch },
    ),
  ).rejects.toThrow(/expired.*unconfirmed|unconfirmed.*expired/i);
});
it("keeps separate qualification reruns distinct and rejects conflicting sequence claims", async () => {
  const { reconcileResourceEvents } =
    await import("../src/product/recovery.js");
  const { branchName } = await import("../src/execution/instacloud.js");
  const runtime: any = { projects: { generation: "g", verification: "v" } };
  const environment = (id: string) => ({
    id,
    role: "verification" as const,
    projectId: "v",
    branch: branchName(id),
  });
  const event = (
    run_id: string,
    sequence: number,
    kind: "INTENT" | "DELETED",
    id: string,
  ) => ({
    schema_version: 1 as const,
    run_id,
    sequence,
    kind,
    at: "2026-09-18T00:00:00Z",
    environment: environment(id),
  });
  const old = [
    event("qualify-123-1", 0, "INTENT", "old"),
    event("qualify-123-1", 1, "DELETED", "old"),
  ];
  const next = event("qualify-123-2", 0, "INTENT", "new");
  expect(reconcileResourceEvents([next, ...old], runtime, 123)).toEqual([
    environment("new"),
  ]);
  expect(() =>
    reconcileResourceEvents([next, { ...next, kind: "DELETED" }], runtime, 123),
  ).toThrow(/conflicting.*sequence/i);
});
