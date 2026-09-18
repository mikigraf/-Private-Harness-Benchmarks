import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { makeFile } from "../src/core/integrity.js";
import { EvidenceStore } from "../src/core/store.js";
import {
  replaceSourceSubtree,
  sourcePatch,
  sourcePatchDigest,
} from "../src/benchmark/source-patch.js";
import {
  controllerPayload,
  controllerPayloadLock,
  archiveRuntimeState,
  hydrateAuthorizedRuntime,
  invalidateQualificationForRuntimeChange,
  managedPayloadDeletions,
  saveSetupRecoveryState,
} from "../src/product/setup.js";
import { recoverSeedMerge } from "../src/product/demo.js";
import type { Config } from "../src/core/config.js";
import type { DemoState, RuntimeLock, SeedItem } from "../src/product/types.js";

const config: Config = {
  githubToken: "synthetic-github",
  repository: "owned/demo",
  demoRepository: "owned/demo",
  instacloudToken: "synthetic-insta",
  orgId: "org-1",
  region: "ams",
  openaiKey: "synthetic-openai",
  model: "synthetic-model",
  reasoningEffort: "medium",
  stateDir: "/unused",
  rates: null,
  maxCost: null,
};

const capability = {
  status: "READY" as const,
  checkedAt: "2026-09-18T00:00:00Z",
  region: "ams",
  observations: {},
  blockers: [],
};

function runtime(
  applicationDigest: string,
): RuntimeLock & { source_digest: string; org_id: string; repository: string } {
  return {
    schema_version: 1,
    projects: { generation: "gen-project", verification: "verify-project" },
    images: {
      generation: "gen@sha256:" + "a".repeat(64),
      verification: "verify@sha256:" + "b".repeat(64),
    },
    application_digest: applicationDigest,
    region: "ams",
    cli_version: "0.0.83",
    codex_version: "test",
    capability,
    created_at: "2026-09-18T00:00:00Z",
    source_digest: "c".repeat(64),
    org_id: "org-1",
    repository: "owned/demo",
  };
}

function state(qualified = true): DemoState {
  return {
    schema_version: 1,
    repository_id: 77,
    repository: "owned/demo",
    default_branch: "main",
    items: [],
    qualified,
  };
}

describe("source patch provenance", () => {
  it("replaces the complete src subtree and binds additions, modifications, deletions, bytes, and mode", () => {
    const base = [
      makeFile("src/change.ts", "before\n"),
      makeFile("src/delete.ts", "deleted\n"),
      makeFile("package-lock.json", "lock-before\n"),
    ];
    const accepted = [
      makeFile("src/change.ts", "after\n", 0o100755),
      makeFile("src/add.ts", "added\n"),
      makeFile("package-lock.json", "lock-after\n"),
    ];

    const reference = replaceSourceSubtree(base, accepted);
    const patch = sourcePatch(base, reference);

    expect(reference.map((file) => file.path)).toEqual([
      "package-lock.json",
      "src/add.ts",
      "src/change.ts",
    ]);
    expect(
      reference.find((file) => file.path === "package-lock.json")?.sha256,
    ).toBe(base[2]?.sha256);
    expect(patch.entries.map((entry) => [entry.path, entry.operation])).toEqual(
      [
        ["src/add.ts", "ADD"],
        ["src/change.ts", "MODIFY"],
        ["src/delete.ts", "DELETE"],
      ],
    );
    expect(patch.entries[1]?.before?.content).toBe(base[0]?.content);
    expect(patch.entries[1]?.after?.content).toBe(accepted[0]?.content);
    expect(patch.entries[1]?.after?.mode).toBe(0o100755);
    expect(sourcePatchDigest(base, reference)).not.toBe(
      sourcePatchDigest(
        base,
        replaceSourceSubtree(base, [makeFile("src/change.ts", "after\n")]),
      ),
    );
  });
});

describe("trusted setup synchronization", () => {
  it("preserves an unpushed merge receipt through setup without reviving stale runtime qualification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fullbeam-seed-recovery-"));
    const store = new EvidenceStore(directory);
    const seed: SeedItem = {
      id: "tenant-event-read",
      issue: 1,
      pr: 2,
      head: "a".repeat(40),
      branch: "fullbeam/seed/tenant-event-read",
      issue_snapshot: {
        title: "Fix tenant isolation",
        body: "Original issue",
        updated_at: "2026-09-18T00:00:00Z",
        captured_at: "2026-09-18T00:00:00Z",
      },
      approved_by: "operator",
      review_mode: "AUTOMATED_DEMO",
    };
    const merged: SeedItem = {
      ...seed,
      base: "b".repeat(40),
      reference: "c".repeat(40),
      merge_receipt: {
        pullNumber: 2,
        marker: seed.id,
        headSha: seed.head!,
        mergeCommitSha: "c".repeat(40),
        mergeMethod: "squash",
        approvedBy: "operator",
        reviewMode: "AUTOMATED_DEMO",
      },
    };
    try {
      await store.saveState("demo-state.json", {
        ...state(true),
        items: [merged],
        last_run_id: 999,
      });
      const remote = { ...state(false), items: [seed] };
      await saveSetupRecoveryState(store, remote);
      const saved = (await store.state<DemoState>("demo-state.json"))!;
      expect(saved.qualified).toBe(false);
      expect(saved.last_run_id).toBeUndefined();
      expect(
        recoverSeedMerge(seed, saved.items[0], {
          merged: true,
          head: { sha: seed.head! },
          merge_commit_sha: "c".repeat(40),
        }),
      ).toMatchObject({
        base: "b".repeat(40),
        reference: "c".repeat(40),
        review_mode: "AUTOMATED_DEMO",
      });
      for (const changed of [
        { ...state(true), repository_id: 88, items: [merged] },
        { ...state(true), repository: "different/demo", items: [merged] },
        { ...state(true), items: [{ ...merged, head: "d".repeat(40) }] },
        {
          ...state(true),
          items: [
            {
              ...merged,
              merge_receipt: {
                ...merged.merge_receipt!,
                marker: "unrelated-task",
              },
            },
          ],
        },
      ]) {
        await store.saveState("demo-state.json", changed);
        await saveSetupRecoveryState(store, remote);
        expect(
          (await store.state<DemoState>("demo-state.json"))!.items[0]!
            .merge_receipt,
        ).toBeUndefined();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("binds the controller payload to repository identity and uses the authenticated actor in CODEOWNERS", async () => {
    const payload = await controllerPayload("actual-operator");
    const lock = controllerPayloadLock(
      77,
      "owned/demo",
      runtime("runtime-a"),
      payload,
    );

    expect(lock).toMatchObject({
      schema_version: 1,
      repository_id: 77,
      repository: "owned/demo",
      runtime_application_digest: "runtime-a",
    });
    expect(lock.payload_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.payload_paths).toEqual(payload.map((file) => file.path).sort());
    const codeowners = payload.find(
      (file) => file.path === ".github/CODEOWNERS",
    );
    expect(Buffer.from(codeowners!.content, "base64").toString("utf8")).toBe(
      "/.fullbeam/ @actual-operator\n/.github/workflows/ @actual-operator\n",
    );
    expect(payload.some((file) => file.path.endsWith("/.env"))).toBe(false);
    expect(
      payload.every(
        (file) =>
          file.path.startsWith(".fullbeam/controller/") ||
          file.path.startsWith(".github/workflows/") ||
          file.path === ".github/CODEOWNERS",
      ),
    ).toBe(true);
  });

  it("deletes stale files only from the prior managed controller payload", () => {
    const next = [makeFile(".fullbeam/controller/src/current.ts", "current")];
    expect(
      managedPayloadDeletions(
        [
          ".fullbeam/controller/src/current.ts",
          ".fullbeam/controller/src/removed.ts",
          ".github/workflows/fullbeam-retired.yml",
        ],
        next,
      ),
    ).toEqual([
      ".fullbeam/controller/src/removed.ts",
      ".github/workflows/fullbeam-retired.yml",
    ]);
    expect(() => managedPayloadDeletions(["src/application.ts"], next)).toThrow(
      /managed payload path/i,
    );
  });

  it("archives old runtime state before an explicit reprovision while preserving resumable target state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "fullbeam-product-refresh-"),
    );
    const store = new EvidenceStore(directory);
    try {
      await store.saveState("runtime.json", { old: true });
      await store.saveState("template-allocation.json", { old: "allocation" });
      const archive = await archiveRuntimeState(
        store,
        new Date("2026-09-18T01:02:03.000Z"),
      );
      expect(archive).toContain("runtime-revisions/2026-09-18T01-02-03.000Z");
      await expect(store.state("runtime.json")).resolves.toBeNull();
      expect(
        JSON.parse(await readFile(join(archive, "runtime.json"), "utf8")),
      ).toEqual({ old: true });
      expect(
        JSON.parse(
          await readFile(join(archive, "template-allocation.json"), "utf8"),
        ),
      ).toEqual({ old: "allocation" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates qualification only when the runtime identity changes", () => {
    expect(
      invalidateQualificationForRuntimeChange(state(true), "same", "same")
        .qualified,
    ).toBe(true);
    expect(
      invalidateQualificationForRuntimeChange(state(true), "old", "new")
        .qualified,
    ).toBe(false);
  });

  it("hydrates a clean local store only from a matching authorized immutable runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fullbeam-product-setup-"));
    const store = new EvidenceStore(directory);
    const remote = runtime("placeholder");
    const { digest } = await import("../src/core/integrity.js");
    remote.application_digest = digest({
      sourceDigest: remote.source_digest,
      images: remote.images,
    });
    try {
      await hydrateAuthorizedRuntime(
        config,
        store,
        remote,
        remote.source_digest,
      );
      await expect(store.state<typeof remote>("runtime.json")).resolves.toEqual(
        remote,
      );
      await expect(
        store.state<{
          roles: { generation: { id: string }; verification: { id: string } };
        }>("template-allocation.json"),
      ).resolves.toMatchObject({
        roles: {
          generation: { id: "gen-project" },
          verification: { id: "verify-project" },
        },
      });

      const other = new EvidenceStore(
        await mkdtemp(join(tmpdir(), "fullbeam-product-setup-bad-")),
      );
      await expect(
        hydrateAuthorizedRuntime(
          config,
          other,
          { ...remote, repository: "attacker/repo" },
          remote.source_digest,
        ),
      ).rejects.toThrow(/repository/i);
      await rm(other.root, { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
