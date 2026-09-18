import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createNativeToolProbe,
  verifyNativeToolProbe,
  InstacloudExecutor,
  INSTA_CLI_VERSION,
  branchName,
} from "../src/execution/instacloud.js";
import type { ArtifactManifest } from "../src/execution/types.js";

it("requires an actual workspace command trace and nonce-bound declared-file receipt", async () => {
  const probe = createNativeToolProbe("probe-nonce-123");
  const root = await mkdtemp(join(tmpdir(), "fullbeam-tool-probe-"));
  try {
    for (const file of probe.bundle.files)
      await writeFile(
        join(root, file.path),
        Buffer.from(file.content, "base64"),
      );
    const output = execFileSync(process.execPath, ["fullbeam-probe.cjs"], {
      cwd: root,
      encoding: "utf8",
    });
    const files = await Promise.all(
      probe.bundle.files.map(async (file) => {
        const content = await readFile(join(root, file.path));
        return {
          ...file,
          content: content.toString("base64"),
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      }),
    );
    const manifest = (entries: typeof files) =>
      entries.map(({ content: _, ...file }) => file);
    const result: ArtifactManifest = {
      executionId: "test-tool-probe",
      role: "generation",
      startedAt: "2026-09-18T00:00:00Z",
      endedAt: "2026-09-18T00:00:01Z",
      durationMs: 1000,
      status: "COMPLETED",
      exitCode: 0,
      files,
      beforeManifest: manifest(probe.bundle.files),
      afterManifest: manifest(files),
      violations: [],
      events: JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "/bin/bash -lc 'node fullbeam-probe.cjs'",
          status: "completed",
          exit_code: 0,
          aggregated_output: output,
        },
      }),
      stderr: "",
      logsTruncated: false,
      usage: [],
      checks: [],
      integrityVerified: true,
      effectiveNativeSettings: { status: "VERIFIED" },
    };
    expect(verifyNativeToolProbe(result, probe)).toMatchObject({
      status: "VERIFIED",
      command: "node fullbeam-probe.cjs",
      nonce: "probe-nonce-123",
    });
    for (const changed of [
      {
        ...result,
        events: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: output },
        }),
      },
      {
        ...result,
        events: result.events.replace('"exit_code":0', '"exit_code":1'),
      },
      {
        ...result,
        events: result.events.replace("probe-nonce-123", "wrong-nonce"),
      },
      { ...result, logsTruncated: true },
      { ...result, violations: ["fullbeam-probe.cjs"] },
      { ...result, effectiveNativeSettings: { status: "UNKNOWN" } },
      {
        ...result,
        files: result.files.filter(
          (file) => file.path !== "probe-receipt.json",
        ),
      },
    ])
      expect(() => verifyNativeToolProbe(changed, probe)).toThrow();
    const wrong = structuredClone(result);
    const receipt = wrong.files.find(
      (file) => file.path === "probe-receipt.json",
    )!;
    const content = JSON.stringify({
      nonce: "wrong-nonce",
      input_sha256: probe.inputSha256,
    });
    receipt.content = Buffer.from(content).toString("base64");
    receipt.size = Buffer.byteLength(content);
    receipt.sha256 = createHash("sha256").update(content).digest("hex");
    wrong.afterManifest = manifest(wrong.files);
    expect(() => verifyNativeToolProbe(wrong, probe)).toThrow(/receipt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["COMPLETED", "FAILED"] as const)(
  "retains native failure artifacts before cleanup when the remote execution is %s",
  async (terminalState) => {
    const executor = new InstacloudExecutor({
      apiKey: "synthetic-insta",
      orgId: "org",
      generationProjectId: "generation",
      verifierProjectId: "verification",
      openaiApiKey: "synthetic-openai",
      model: "fixture-model",
      runtimeImages: {
        generation: "image@sha256:" + "a".repeat(64),
        verification: "image@sha256:" + "b".repeat(64),
      },
    });
    const failure: ArtifactManifest = {
      executionId: "native-probe",
      role: "generation",
      startedAt: "2026-09-18T00:00:00Z",
      endedAt: "2026-09-18T00:00:01Z",
      durationMs: 1000,
      status: terminalState === "FAILED" ? "INFRA_ERROR" : "COMPLETED",
      exitCode: terminalState === "FAILED" ? 1 : 0,
      checks: [],
      files: [],
      beforeManifest: [],
      afterManifest: [],
      violations: [],
      events: "Retained native diagnostic trace",
      stderr: "Retained native terminal error",
      logsTruncated: false,
      usage: [],
      integrityVerified: true,
      effectiveNativeSettings: { status: "UNKNOWN" },
      nativeVersion: "codex-cli 0.125.0",
    };
    vi.spyOn(executor as any, "run").mockResolvedValue(INSTA_CLI_VERSION);
    vi.spyOn(executor as any, "discoverSchemas").mockResolvedValue({
      snapshot: [],
      hash: "schema",
    });
    vi.spyOn(executor as any, "assertCleanTemplate").mockResolvedValue(
      undefined,
    );
    vi.spyOn(executor, "createAttemptEnvironment").mockImplementation(
      async (spec) => ({
        id: spec.id,
        role: spec.role,
        projectId: spec.role,
        branch: branchName(spec.id),
      }),
    );
    vi.spyOn(executor as any, "command").mockImplementation(
      async (_environment, verb) => {
        if (verb === "probe")
          return {
            nativeConfigVerified: true,
            cleanTemplate: true,
            credentialIsolation: true,
            nativeSandbox: true,
          };
        if (verb === "start-probe") return { executionId: "detached" };
        if (verb === "status") return { state: "COMPLETED" };
        throw new Error("Unexpected provider command");
      },
    );
    vi.spyOn(executor, "putBundle").mockResolvedValue(undefined);
    vi.spyOn(executor, "start").mockImplementation(async (environment) => ({
      environment,
      executionId: "native-probe",
    }));
    vi.spyOn(executor, "poll").mockResolvedValue({
      executionId: "native-probe",
      state: terminalState,
      startedAt: failure.startedAt,
    });
    vi.spyOn(executor, "collect").mockImplementation(async (ref) => ({
      ...failure,
      executionId: ref.executionId,
    }));
    vi.spyOn(executor, "destroy").mockResolvedValue(undefined);
    try {
      const report = await executor.preflight();
      expect(report.status).toBe("BLOCKED");
      expect(report.observations.nativeModelProxy).toMatchObject({
        status: "FAILED",
        artifact: {
          executionId: "native-probe",
          events: "Retained native diagnostic trace",
          stderr: "Retained native terminal error",
        },
      });
      expect(report.observations.nativeToolExecution).toMatchObject({
        status: "FAILED",
      });
      expect(report.observations.deletionConfirmed).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
