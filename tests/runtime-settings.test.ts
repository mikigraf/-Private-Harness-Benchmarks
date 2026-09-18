import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

let codexPath: string | undefined;
try {
  const executable = execFileSync("which", ["codex"], {
    encoding: "utf8",
  }).trim();
  if (
    execFileSync(executable, ["--version"], { encoding: "utf8" }).trim() ===
    "codex-cli 0.125.0"
  )
    codexPath = executable;
} catch {}

// Native characterization: no API credentials, model calls, or task execution.
describe.skipIf(!codexPath)("pinned native configuration evidence", () => {
  async function fixture(trusted = true) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fullbeam-native-settings-")),
    );
    const cwd = join(root, "work"),
      home = join(root, "home");
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await mkdir(join(cwd, ".agents/skills/fixture"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex/config.toml"),
      trusted
        ? `[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`
        : "",
    );
    await writeFile(
      join(cwd, ".codex/config.toml"),
      'model="fixture-model"\nmodel_reasoning_effort="high"\napproval_policy="never"\nsandbox_mode="workspace-write"\nweb_search="disabled"\n',
    );
    await writeFile(
      join(cwd, ".agents/skills/fixture/SKILL.md"),
      "---\nname: fixture\ndescription: Check native skill discovery.\n---\nFollow the fixture contract.\n",
    );
    return { root, cwd, home };
  }
  const input = { model: "fixture-model", reasoningEffort: "high" };
  const runtime = () => import("../runtime/supervisor.mjs" as string);

  it("observes the trusted candidate layer and native skill without calling a model", async () => {
    const f = await fixture();
    try {
      const { inspectNativeSettings } = await runtime();
      const evidence = await inspectNativeSettings(input, {
        ...f,
        uid: process.getuid?.(),
        codexPath,
        port: 9,
        expectedSkills: [".agents/skills/fixture/SKILL.md"],
      });
      expect(evidence.status).toBe("VERIFIED");
      expect(evidence.model).toBe("fixture-model");
      expect(evidence.reasoningEffort).toBe("high");
      expect(evidence.projectConfig.enabled).toBe(true);
      expect(evidence.nativeSkills).toContainEqual(
        expect.objectContaining({
          name: "fixture",
          scope: "repo",
          enabled: true,
        }),
      );
      expect(evidence.providerWireApi).toBe("responses");
      expect(evidence.modelProvider).toBe("fullbeam");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a project layer ignored for lack of trust even when CLI overrides match", async () => {
    const f = await fixture(false);
    try {
      const { inspectNativeSettings } = await runtime();
      await expect(
        inspectNativeSettings(input, {
          ...f,
          uid: process.getuid?.(),
          codexPath,
          port: 9,
        }),
      ).rejects.toThrow(/native project configuration.*not enabled/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a frozen skill the native loader did not discover", async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.cwd, ".agents/skills/fixture/SKILL.md"),
        "This has no skill metadata.\n",
      );
      const { inspectNativeSettings } = await runtime();
      await expect(
        inspectNativeSettings(input, {
          ...f,
          uid: process.getuid?.(),
          codexPath,
          port: 9,
          expectedSkills: [".agents/skills/fixture/SKILL.md"],
        }),
      ).rejects.toThrow(/native skill/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
