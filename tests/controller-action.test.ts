import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { controllerPayload } from "../src/product/setup.js";

const execute = promisify(execFile);

it("ships a native JavaScript action that delivers artifact runtime credentials and dispatch argv to the trusted controller", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fullbeam-controller-action-")),
  );
  try {
    const payload = await controllerPayload("test-operator");
    const workflowFile = payload.find(
      (file) => file.path === ".github/workflows/fullbeam-compare.yml",
    )!;
    const workflow = parse(
      Buffer.from(workflowFile.content, "base64").toString(),
    );
    const controller = workflow.jobs.controller.steps.find(
      (step: { id?: string }) => step.id === "controller",
    );
    expect(controller.run).toBeUndefined();
    expect(controller.uses).toMatch(/^\.\/\.fullbeam\/controller\//);
    const actionDirectory = controller.uses.replace(/^\.\//, "");
    const actionFile = payload.find(
      (file) => file.path === `${actionDirectory}/action.yml`,
    )!;
    const action = parse(Buffer.from(actionFile.content, "base64").toString());
    expect(action.runs.using).toBe("node24");
    const entry = payload.find(
      (file) => file.path === `${actionDirectory}/${action.runs.main}`,
    )!;
    const entryPath = join(root, entry.path);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, Buffer.from(entry.content, "base64"));
    const controllerRoot = join(root, ".fullbeam/controller");
    await mkdir(join(controllerRoot, "src"));
    await symlink(
      resolve("node_modules"),
      join(controllerRoot, "node_modules"),
      "dir",
    );
    await writeFile(
      join(controllerRoot, "src/cli.ts"),
      `
      console.log(JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        runtimePresent: process.env.ACTIONS_RUNTIME_TOKEN === "synthetic-runtime-token",
        resultsPresent: process.env.ACTIONS_RESULTS_URL === "https://results.example.test/",
        providerPresent: process.env.OPENAI_API_KEY === "synthetic-provider-key"
      }));
      process.exitCode = Number(process.env.TEST_CONTROLLER_EXIT_CODE || "0");
    `,
    );
    const environment = {
      ...process.env,
      GITHUB_ACTIONS: "true",
      ACTIONS_RUNTIME_TOKEN: "synthetic-runtime-token",
      ACTIONS_RESULTS_URL: "https://results.example.test/",
      OPENAI_API_KEY: "synthetic-provider-key",
      FULLBEAM_OPERATION: "compare",
      FULLBEAM_CANDIDATE_PR: "12",
      FULLBEAM_TRIGGER_ID: "trigger-12",
      FULLBEAM_PREVIOUS_ID: "previous-$()-literal",
    };
    const observed = await execute(process.execPath, [entryPath], {
      env: environment,
    });
    expect(JSON.parse(observed.stdout)).toEqual({
      argv: [
        "controller",
        "--operation",
        "compare",
        "--trigger",
        "trigger-12",
        "--pr",
        "12",
        "--previous",
        "previous-$()-literal",
      ],
      cwd: controllerRoot,
      runtimePresent: true,
      resultsPresent: true,
      providerPresent: true,
    });
    expect(observed.stderr).toBe("");
    expect(observed.stdout).not.toContain("synthetic-runtime-token");
    const qualified = await execute(process.execPath, [entryPath], {
      env: {
        ...environment,
        FULLBEAM_OPERATION: "qualify",
        FULLBEAM_CANDIDATE_PR: "",
        FULLBEAM_PREVIOUS_ID: "",
      },
    });
    expect(JSON.parse(qualified.stdout).argv).toEqual([
      "controller",
      "--operation",
      "qualify",
      "--trigger",
      "trigger-12",
    ]);
    await expect(
      execute(process.execPath, [entryPath], {
        env: { ...environment, FULLBEAM_CANDIDATE_PR: "12; exit 0" },
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execute(process.execPath, [entryPath], {
        env: { ...environment, ACTIONS_RUNTIME_TOKEN: "" },
      }),
    ).rejects.toMatchObject({ code: 1, stdout: "" });
    await expect(
      execute(process.execPath, [entryPath], {
        env: { ...environment, TEST_CONTROLLER_EXIT_CODE: "23" },
      }),
    ).rejects.toMatchObject({ code: 23 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
