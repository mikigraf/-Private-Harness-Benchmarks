import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  digest,
  makeFile,
  validateBundle,
  validateSubmittedFiles,
} from "../src/core/integrity.js";
import {
  loadConfig,
  redact,
  assertPublicEnvironmentTemplate,
  secretsOf,
} from "../src/core/config.js";
import { EvidenceStore } from "../src/core/store.js";

describe("integrity boundaries", () => {
  it("hashes semantic JSON canonically and rejects undefined/nonfinite", () => {
    expect(digest({ b: 2, a: { y: 2, x: 1 } })).toBe(
      digest({ a: { x: 1, y: 2 }, b: 2 }),
    );
    expect(() => canonical({ bad: NaN })).toThrow();
    expect(() => canonical({ bad: undefined })).toThrow();
  });
  it("rejects traversal, duplicate paths, unsupported modes and digest tampering", () => {
    for (const path of [
      "../secret",
      "/etc/passwd",
      "a/../secret",
      "a\\b",
      ".git/config",
      "a//b",
    ])
      expect(() => makeFile(path, "x")).toThrow();
    const file = makeFile("src/app.ts", "ok");
    expect(() => validateBundle([file, file])).toThrow();
    expect(() =>
      validateBundle([
        { ...file, content: Buffer.from("bad").toString("base64") },
      ]),
    ).toThrow();
    expect(() => validateBundle([{ ...file, mode: 0o120000 }])).toThrow();
  });
  it("detects protected deletion and new tests; permits source deletion", () => {
    const before = [
      makeFile("package.json", "{}"),
      makeFile("src/app.ts", "x"),
      makeFile("tests/public/a.ts", "x"),
    ];
    expect(
      validateSubmittedFiles(before, [
        ...before.slice(0, 1),
        before[2]!,
        makeFile("tests/agent/new.ts", "ok"),
      ]).violations,
    ).toEqual([]);
    expect(
      validateSubmittedFiles(before, before.slice(1)).violations,
    ).toContain("package.json");
    expect(
      validateSubmittedFiles(before, [
        ...before,
        makeFile("tests/public/new.ts", "bad"),
      ]).violations,
    ).toContain("tests/public/new.ts");
  });
});
describe("configuration and immutable store", () => {
  it("rejects populated credential templates before publishing controller files", () => {
    expect(() =>
      assertPublicEnvironmentTemplate(
        "OPENAI_API_KEY=\nFULLBEAM_MODEL=test-model\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicEnvironmentTemplate(
        "OPENAI_API_KEY=synthetic-sensitive-value\n",
      ),
    ).toThrow("OPENAI_API_KEY");
    try {
      assertPublicEnvironmentTemplate("HR_API_KEY=synthetic-sensitive-value\n");
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-sensitive-value");
    }
  });
  it("reports missing names without credentials and never invents a model", () => {
    expect(() => loadConfig({}, false)).toThrow("FULLBEAM_GITHUB_TOKEN");
    expect(redact("secret-token", ["secret-token"])).toBe("[REDACTED]");
  });
  it("redacts the database URL and decoded password and rejects credential templates", () => {
    const config = loadConfig({
      FULLBEAM_GITHUB_TOKEN: "github-test",
      FULLBEAM_DEMO_REPOSITORY: "owner/repo",
      FULLBEAM_INSTACLOUD_API_TOKEN: "insta-test",
      INSTA_ORG_ID: "org",
      FULLBEAM_INSTACLOUD_REGION: "us-east",
      OPENAI_API_KEY: "openai-test",
      FULLBEAM_MODEL: "model",
      DATABASE_URL:
        "postgresql://test:private%21password@db.example/test?sslmode=verify-full",
    });
    expect(
      redact(`${config.databaseUrl} private!password`, secretsOf(config)),
    ).toBe("[REDACTED] [REDACTED]");
    expect(() =>
      assertPublicEnvironmentTemplate(`DATABASE_URL=${config.databaseUrl}\n`),
    ).toThrow("DATABASE_URL");
  });
  it("uses content addressed immutable evidence and catches tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "fullbeam-test-"));
    const store = new EvidenceStore(root);
    const ref = await store.putJson({ kind: "test-data", ok: true });
    expect(await store.readJson(ref)).toEqual({ kind: "test-data", ok: true });
    await writeFile(join(root, "objects", ref.id), "tamper");
    await expect(store.readJson(ref)).rejects.toThrow("integrity");
  });
});
