import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Workflow = {
  name: string;
  "run-name"?: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      outputs?: Record<string, string>;
      steps: Array<{
        id?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }>;
    }
  >;
};

async function workflow(name: string): Promise<Workflow> {
  return parse(
    await readFile(resolve("templates/workflows", name), "utf8"),
  ) as Workflow;
}

const PINNED_ACTIONS = new Set([
  "./.fullbeam/controller/templates/actions/controller",
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
]);

function allSteps(
  value: Workflow,
): Array<Workflow["jobs"][string]["steps"][number]> {
  return Object.values(value.jobs).flatMap((job) => job.steps);
}

function job(value: Workflow, name: string): Workflow["jobs"][string] {
  const selected = value.jobs[name];
  if (!selected) throw new Error(`Workflow is missing job ${name}`);
  return selected;
}

describe("Fullbeam comparison workflow", () => {
  it("accepts the frozen dispatch contract and runs only the protected default-branch commit", async () => {
    const value = await workflow("fullbeam-compare.yml");
    const dispatch = value.on.workflow_dispatch as {
      inputs: Record<
        string,
        { type: string; required: boolean; options?: string[] }
      >;
    };

    expect(value["run-name"]).toBe(
      "Fullbeam ${{ inputs.operation }} ${{ inputs.trigger_id }}",
    );
    expect(dispatch.inputs.operation).toMatchObject({
      type: "choice",
      required: true,
      options: ["compare", "qualify"],
    });
    expect(dispatch.inputs.candidate_pr).toMatchObject({
      type: "string",
      required: false,
    });
    expect(dispatch.inputs.trigger_id).toMatchObject({
      type: "string",
      required: true,
    });
    expect(dispatch.inputs.previous_id).toMatchObject({
      type: "string",
      required: false,
    });
    expect(value.permissions).toEqual({ contents: "read", actions: "read" });
    const controllerJob = job(value, "controller");
    expect(controllerJob.if).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    const checkout = controllerJob.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": "false",
    });
    expect(
      controllerJob.steps.some(
        (step) => step.run === "test -f ../../.fullbeam/runtime.lock.json",
      ),
    ).toBe(true);
  });

  it("pins trusted actions and passes untrusted dispatch values through env to the protected JavaScript controller action", async () => {
    const value = await workflow("fullbeam-compare.yml");
    for (const step of allSteps(value).filter((candidate) => candidate.uses))
      expect(PINNED_ACTIONS.has(step.uses!)).toBe(true);
    for (const step of allSteps(value).filter((candidate) => candidate.run))
      expect(step.run).not.toContain("${{");
    const controller = job(value, "controller").steps.find(
      (step) => step.id === "controller",
    );
    expect(controller?.env).toMatchObject({
      FULLBEAM_OPERATION: "${{ inputs.operation }}",
      FULLBEAM_CANDIDATE_PR: "${{ inputs.candidate_pr }}",
      FULLBEAM_TRIGGER_ID: "${{ inputs.trigger_id }}",
      FULLBEAM_PREVIOUS_ID: "${{ inputs.previous_id }}",
    });
    expect(controller?.uses).toBe(
      "./.fullbeam/controller/templates/actions/controller",
    );
    expect(controller?.run).toBeUndefined();
  });

  it("keeps publishing and cleanup in separate least-privilege jobs with private artifacts", async () => {
    const value = await workflow("fullbeam-compare.yml");
    const publishJob = job(value, "publish");
    const controllerJob = job(value, "controller");
    const cleanupJob = job(value, "cleanup");
    expect(publishJob.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
      checks: "write",
    });
    expect(controllerJob.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      issues: "read",
      checks: "read",
    });
    const uploads = controllerJob.steps.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads.map((step) => step.with?.path)).toEqual([
      ".fullbeam/controller/.fullbeam-state/evidence/",
      ".fullbeam/controller/.fullbeam-state/publication/publication.json",
      ".fullbeam/controller/.fullbeam-state/qualification/",
    ]);
    expect(uploads.every((step) => step.with?.overwrite === "false")).toBe(
      true,
    );
    expect(
      uploads.every((step) => step.with?.["include-hidden-files"] === "true"),
    ).toBe(true);
    expect(publishJob.if).toContain("always()");
    expect(publishJob.needs).toBe("controller");
    expect(cleanupJob.if).toContain("always()");
    expect(cleanupJob.needs).toBe("controller");
    expect(
      cleanupJob.steps.some((step) =>
        step.run?.includes('recover --run-id "$FULLBEAM_RUN_ID"'),
      ),
    ).toBe(true);
    expect(
      publishJob.steps.some((step) =>
        step.run?.includes('publish --file "$FULLBEAM_PUBLICATION_FILE"'),
      ),
    ).toBe(true);
  });
});

describe("Fullbeam scheduled cleanup workflow", () => {
  it("runs hourly from the protected default branch with read-only GitHub permissions", async () => {
    const value = await workflow("fullbeam-cleanup.yml");
    expect(value.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(value.on).toHaveProperty("workflow_dispatch");
    expect(value.permissions).toEqual({ contents: "read", actions: "read" });
    expect(value.concurrency).toMatchObject({ "cancel-in-progress": false });
    const sweepJob = job(value, "sweep");
    expect(sweepJob.if).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(
      sweepJob.steps.some((step) =>
        step.run?.includes("npm run fullbeam -- sweep"),
      ),
    ).toBe(true);
    expect(
      sweepJob.steps.some(
        (step) => step.run === "test -f ../../.fullbeam/runtime.lock.json",
      ),
    ).toBe(true);
    for (const step of allSteps(value).filter((candidate) => candidate.uses))
      expect(PINNED_ACTIONS.has(step.uses!)).toBe(true);
  });
});
