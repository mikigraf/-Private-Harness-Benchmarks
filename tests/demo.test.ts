import { describe, expect, it } from "vitest";
import { digest } from "../src/core/integrity.js";
import { materializeFixture } from "../src/benchmark/relaydesk.js";
import {
  assertFixtureMatches,
  assertPassingSeedCheck,
  changedFixtureFiles,
  qualificationInputDigest,
  recoverSeedMerge,
  requestReview,
  reviewSeedCheck,
  resumeQualification,
  type QualificationInput,
  type StoredQualification,
} from "../src/product/demo.js";
import type { QualificationOutput } from "../src/product/qualification.js";
import type { SeedItem } from "../src/product/types.js";

describe("demo seed resumability", () => {
  it("requires the complete expected application tree, including the newly public regression test", async () => {
    const base = await materializeFixture(0);
    const reference = await materializeFixture(1);
    expect(() => assertFixtureMatches(base, base, "base")).not.toThrow();
    const changed = changedFixtureFiles(base, reference);
    expect(changed.map((file) => file.path)).toEqual([
      "src/events/repository.ts",
      "tests/public/tenant-event-read.test.ts",
    ]);
    expect(() =>
      assertFixtureMatches(
        reference.filter(
          (file) => file.path !== "tests/public/tenant-event-read.test.ts",
        ),
        reference,
        "reference",
      ),
    ).toThrow(/reference.*tenant-event-read/i);
  });

  it("recovers only an exact locally persisted squash receipt for a live merged PR", () => {
    const remote: SeedItem = seedItem();
    const local: SeedItem = {
      ...seedItem(),
      merge_receipt: receipt(),
      base: "b".repeat(40),
      reference: "c".repeat(40),
    };
    expect(
      recoverSeedMerge(remote, local, {
        merged: true,
        head: { sha: "a".repeat(40) },
        merge_commit_sha: "c".repeat(40),
      }),
    ).toMatchObject({
      merge_receipt: receipt(),
      base: "b".repeat(40),
      reference: "c".repeat(40),
    });
    expect(() =>
      recoverSeedMerge(remote, local, {
        merged: true,
        head: { sha: "a".repeat(40) },
        merge_commit_sha: "d".repeat(40),
      }),
    ).toThrow(/receipt/i);
    expect(() =>
      recoverSeedMerge(remote, undefined, {
        merged: true,
        head: { sha: "a".repeat(40) },
        merge_commit_sha: "c".repeat(40),
      }),
    ).toThrow(/persisted.*receipt/i);
  });

  it("retains automated provenance during merge recovery and rejects a conflicting review mode", () => {
    const remote = seedItem();
    const local: SeedItem = {
      ...seedItem(),
      review_mode: "AUTOMATED_DEMO",
      review_evidence: {
        id: "e".repeat(64),
        sha256: "e".repeat(64),
        media_type: "application/json",
      },
      merge_receipt: { ...receipt(), reviewMode: "AUTOMATED_DEMO" },
      base: "b".repeat(40),
      reference: "c".repeat(40),
    };
    const pull = {
      merged: true,
      head: { sha: "a".repeat(40) },
      merge_commit_sha: "c".repeat(40),
    };
    const recovered = recoverSeedMerge(remote, local, pull);
    expect(recovered.review_mode).toBe("AUTOMATED_DEMO");
    expect(recovered.review_evidence?.sha256).toBe("e".repeat(64));
    expect(() =>
      recoverSeedMerge(remote, { ...local, review_mode: "HUMAN" }, pull),
    ).toThrow(/receipt/i);
  });

  it("accepts seed evidence only when status, integrity, policy, and every expected check pass", () => {
    const checks = [
      "tenant-read.foreign-is-404",
      "tenant-read.foreign-body-redacted",
      "tenant-read.owner-is-200",
      "tenant-read.unknown-is-404",
      "tenant-read.independent-owner",
      "common.health",
    ].map((id) => ({ id, status: "PASS" }));
    const valid = {
      status: "COMPLETED",
      integrityVerified: true,
      violations: [],
      buildPassed: true,
      startupPassed: true,
      checks,
    };
    expect(() =>
      assertPassingSeedCheck(valid, "tenant-event-read"),
    ).not.toThrow();
    expect(() =>
      assertPassingSeedCheck(
        { ...valid, status: "POLICY_VIOLATION" },
        "tenant-event-read",
      ),
    ).toThrow();
    expect(() =>
      assertPassingSeedCheck(
        { ...valid, integrityVerified: false },
        "tenant-event-read",
      ),
    ).toThrow();
    expect(() =>
      assertPassingSeedCheck(
        { ...valid, violations: ["package.json"] },
        "tenant-event-read",
      ),
    ).toThrow();
  });

  it("automates known passing seed checks while recording automation instead of human review", async () => {
    const item = { ...seedItem(), approved_by: undefined };
    const evidence = {
      id: "e".repeat(64),
      sha256: "e".repeat(64),
      media_type: "application/json",
    };
    const result = {
      status: "COMPLETED",
      integrityVerified: true,
      violations: [],
      buildPassed: true,
      startupPassed: true,
      checks: [
        "tenant-read.foreign-is-404",
        "tenant-read.foreign-body-redacted",
        "tenant-read.owner-is-200",
        "tenant-read.unknown-is-404",
        "tenant-read.independent-owner",
        "common.health",
      ].map((id) => ({ id, status: "PASS" })),
    };
    const recorded = await reviewSeedCheck(item, evidence, result, "operator", {
      automated: true,
    });
    expect(recorded).toMatchObject({
      approved_by: "operator",
      review_mode: "AUTOMATED_DEMO",
      review_evidence: evidence,
    });
    expect(item.approved_by).toBeUndefined();
    await expect(
      reviewSeedCheck(
        item,
        evidence,
        { ...result, integrityVerified: false },
        "operator",
        { automated: true },
      ),
    ).rejects.toThrow(/integrity/i);
    await expect(
      reviewSeedCheck(item, evidence, result, "operator", {
        automated: true,
        approveSeed: item.head,
      }),
    ).rejects.toThrow(/human/i);
    await expect(
      reviewSeedCheck(
        { ...item, id: "customer-history" },
        evidence,
        result,
        "operator",
        { automated: true },
      ),
    ).rejects.toThrow(/known fixture/i);
    await expect(
      reviewSeedCheck(item, evidence, result, "reviewer", {
        approveSeed: item.head,
      }),
    ).resolves.toMatchObject({ review_mode: "HUMAN", approved_by: "reviewer" });
    await expect(
      reviewSeedCheck(item, evidence, result, "reviewer", {
        approveSeed: "short",
      }),
    ).resolves.toBeNull();
  });
});

describe("qualification approval resumability", () => {
  it("reuses the exact pending output and invalidates it when frozen inputs change", () => {
    const input = qualificationInput();
    const output = qualificationOutput(input);
    const pending: StoredQualification = {
      schema_version: 1,
      input_digest: qualificationInputDigest(input),
      review_url: "https://example.test/run/7",
      output,
    };
    expect(resumeQualification(pending, input)).toBe(output);
    expect(
      resumeQualification(pending, {
        ...input,
        verifier_digest: "f".repeat(64),
      }),
    ).toBeNull();
  });

  it("rejects a tampered pending qualification instead of approving or silently reusing it", () => {
    const input = qualificationInput();
    const output = qualificationOutput(input);
    output.actions_run_id = "tampered";
    const pending: StoredQualification = {
      schema_version: 1,
      input_digest: qualificationInputDigest(input),
      review_url: "https://example.test/run/7",
      output,
    };
    expect(() => resumeQualification(pending, input)).toThrow(/integrity/i);
  });

  it("requires the full displayed digest for noninteractive approval", async () => {
    const identity = "a".repeat(64);
    await expect(
      requestReview("review", identity, identity.slice(0, 12)),
    ).resolves.toBe(false);
    await expect(requestReview("review", identity, identity)).resolves.toBe(
      true,
    );
  });
});

function receipt() {
  return {
    pullNumber: 10,
    marker: "tenant-event-read",
    headSha: "a".repeat(40),
    mergeCommitSha: "c".repeat(40),
    mergeMethod: "squash" as const,
    approvedBy: "reviewer",
  };
}

function seedItem(): SeedItem {
  return {
    id: "tenant-event-read",
    issue: 9,
    issue_snapshot: {
      title: "issue",
      body: "body",
      updated_at: "2026-09-18T00:00:00Z",
      captured_at: "2026-09-18T00:00:01Z",
    },
    pr: 10,
    head: "a".repeat(40),
    branch: "fullbeam/seed/tenant-event-read",
    approved_by: "reviewer",
  };
}

function qualificationInput(): QualificationInput {
  return {
    repository_id: "123",
    source_commit: "1".repeat(40),
    runtime_digest: "2".repeat(64),
    verification_image: "image@sha256:" + "3".repeat(64),
    policy_digest: "4".repeat(64),
    verifier_digest: "5".repeat(64),
    tasks: [],
  };
}

function qualificationOutput(input: QualificationInput): QualificationOutput {
  const output = {
    schema_version: 1 as const,
    repository_id: input.repository_id,
    source_commit: input.source_commit,
    runtime: {
      application_digest: input.runtime_digest,
      images: { verification: input.verification_image },
    },
    policy_digest: input.policy_digest,
    packages: [],
    artifact_objects: {},
    actions_run_id: "7",
    approval_digest: "",
  } as unknown as QualificationOutput;
  const { approval_digest: _ignored, ...payload } = output;
  output.approval_digest = digest(payload);
  return output;
}
