import { it, expect } from "vitest";
import {
  resolveHarness,
  resolveHarnessForComparison,
  isHarnessPath,
  classifyHarnessChange,
} from "../src/harness/resolve.js";
import { makeFile } from "../src/core/integrity.js";
const files = [
  makeFile("AGENTS.md", "General instructions"),
  makeFile(
    ".agents/skills/verify/SKILL.md",
    "---\nname: verify\ndescription: verify work\n---\nRun documented tests",
  ),
  makeFile(
    ".codex/config.toml",
    'model = "configured-model"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n',
  ),
];
it("binds exact harness files, modes, and settings to immutable release", () => {
  const a = resolveHarness(
    files,
    "a".repeat(40),
    {
      generation: "registry/a@sha256:" + "b".repeat(64),
      application: "sha256:" + "c".repeat(64),
    },
    "current",
  );
  const b = resolveHarness(
    [
      ...files.slice(0, 2),
      makeFile(
        ".codex/config.toml",
        'model = "another-model"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n',
      ),
    ],
    "b".repeat(40),
    {
      generation: "registry/a@sha256:" + "b".repeat(64),
      application: "sha256:" + "c".repeat(64),
    },
    "candidate",
  );
  expect(a.release.digest).not.toBe(b.release.digest);
  expect(a.release.requested_model).toBe("configured-model");
  expect(a.observations.every((c) => c.observed_use === "UNKNOWN")).toBe(true);
});
it("does not allow policy/controller/application paths as harness changes", () => {
  expect(isHarnessPath(".agents/skills/verify/script.sh")).toBe(true);
  expect(isHarnessPath(".fullbeam/policy.yaml")).toBe(false);
  expect(isHarnessPath(".fullbeam/controller/templates/AGENTS.md")).toBe(false);
  expect(isHarnessPath(".fullbeam/private/AGENTS.md")).toBe(false);
  expect(isHarnessPath(".github/AGENTS.md")).toBe(false);
  expect(isHarnessPath(".fullbeam/release.yaml")).toBe(true);
  expect(isHarnessPath("src/AGENTS.md")).toBe(true);
  expect(isHarnessPath("src/app.ts")).toBe(false);
});
it("does not materialize managed controller instructions into a native release", () => {
  const resolved = resolveHarness(
    [
      ...files,
      makeFile(".fullbeam/controller/templates/AGENTS.md", "Controller only"),
      makeFile(".github/AGENTS.md", "Workflow only"),
      makeFile("src/AGENTS.md", "Application instructions"),
    ],
    "a".repeat(40),
    { generation: "image", application: "app" },
    "current",
  );
  expect(resolved.files.map((file) => file.path)).toEqual([
    ...files.map((file) => file.path),
    "src/AGENTS.md",
  ]);
});
it("rejects dangerous or unsupported native settings rather than overriding them", () => {
  expect(() =>
    resolveHarness(
      [
        ...files.slice(0, 2),
        makeFile(
          ".codex/config.toml",
          'model="x"\nsandbox_mode="danger-full-access"',
        ),
      ],
      "a".repeat(40),
      { generation: "image", application: "app" },
      "current",
    ),
  ).toThrow();
});
it("snapshots deterministic candidate configuration errors as immutable non-executable releases", () => {
  const missingModel = resolveHarnessForComparison(
    files.slice(0, 2),
    "a".repeat(40),
    {
      generation: "registry/a@sha256:" + "b".repeat(64),
      application: "sha256:" + "c".repeat(64),
    },
    "candidate",
  );
  expect(missingModel.configurationError).toMatch(
    /missing native Codex configuration/i,
  );
  expect(missingModel.release.requested_model).toBe("UNKNOWN_UNRESOLVED");
  expect(missingModel.files.map((file) => file.path)).toEqual(
    files.slice(0, 2).map((file) => file.path),
  );
  const malformed = resolveHarnessForComparison(
    [...files.slice(0, 2), makeFile(".codex/config.toml", "model = [")],
    "a".repeat(40),
    {
      generation: "registry/a@sha256:" + "b".repeat(64),
      application: "sha256:" + "c".repeat(64),
    },
    "candidate",
  );
  expect(malformed.configurationError).toMatch(/configuration/i);
  expect(malformed.release.digest).not.toBe(missingModel.release.digest);
  const dangerous = resolveHarnessForComparison(
    [
      ...files.slice(0, 2),
      makeFile(
        ".codex/config.toml",
        'model="x"\napproval_policy="never"\nsandbox_mode="danger-full-access"\nweb_search="disabled"',
      ),
    ],
    "a".repeat(40),
    {
      generation: "registry/a@sha256:" + "b".repeat(64),
      application: "sha256:" + "c".repeat(64),
    },
    "candidate",
  );
  expect(dangerous.configurationError).toContain("workspace-write");
});
it("does not downgrade malformed bundle integrity to a candidate configuration loss", () => {
  const damaged = { ...files[0]!, sha256: "0".repeat(64) };
  expect(() =>
    resolveHarnessForComparison(
      [damaged, ...files.slice(1)],
      "a".repeat(40),
      { generation: "image", application: "app" },
      "candidate",
    ),
  ).toThrow(/integrity/i);
});

it("classifies effective model settings independently from versioned harness content", () => {
  const current = {
    files,
    settings: {
      model: "before",
      model_reasoning_effort: "medium",
      approval_policy: "never",
    },
  };
  const model = {
    ...current,
    settings: { ...current.settings, model: "after" },
  };
  const effort = {
    ...current,
    settings: { ...current.settings, model_reasoning_effort: "high" },
  };
  const instructions = {
    ...current,
    files: [makeFile("AGENTS.md", "Revised instructions"), ...files.slice(1)],
  };
  expect(classifyHarnessChange(current, model)).toBe("MODEL_ONLY");
  expect(classifyHarnessChange(current, effort)).toBe("MODEL_ONLY");
  expect(classifyHarnessChange(current, instructions)).toBe("HARNESS_ONLY");
  expect(
    classifyHarnessChange(current, {
      ...instructions,
      settings: model.settings,
    }),
  ).toBe("BUNDLE");
  expect(
    classifyHarnessChange(current, {
      ...model,
      configurationError: "unsupported setting",
    }),
  ).toBe("UNKNOWN");
});

it("ignores TOML formatting but retains deletions, permission settings, and executable mode changes", () => {
  const current = {
    files,
    settings: { model: "before", approval_policy: "never" },
  };
  const reformatted = {
    ...current,
    files: [
      ...files.slice(0, 2),
      makeFile(
        ".codex/config.toml",
        '# new comment\nmodel="before"\napproval_policy="never"\n',
      ),
    ],
  };
  expect(classifyHarnessChange(current, reformatted)).toBe("UNCHANGED");
  expect(
    classifyHarnessChange(current, {
      ...current,
      files: files.filter((file) => !file.path.startsWith(".agents/")),
    }),
  ).toBe("HARNESS_ONLY");
  expect(
    classifyHarnessChange(current, {
      ...current,
      files: files.map((file) =>
        file.path === "AGENTS.md" ? { ...file, mode: 0o100755 } : file,
      ),
    }),
  ).toBe("HARNESS_ONLY");
  expect(
    classifyHarnessChange(current, {
      ...current,
      settings: { ...current.settings, approval_policy: "on-request" },
    }),
  ).toBe("HARNESS_ONLY");
});
