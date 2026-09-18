import { it, expect } from "vitest";
import { evaluateCalibration } from "../src/benchmark/qualify.js";
import {
  assertQualificationControlResult,
  assertTaskQualification,
  finalizeQualificationPackage,
} from "../src/product/qualification.js";
import { digest, makeFile, manifestDigest } from "../src/core/integrity.js";
import { freezeRecord, type Task } from "../src/core/records.js";
import type { BenchmarkLock, TaskPackage } from "../src/product/types.js";
const control = (kind: "base" | "reference" | "mutant", repeat: 1 | 2) => ({
  kind,
  repeat,
  subject_digest: "a".repeat(64),
  buildPassed: true,
  startupPassed: true,
  checks: [
    { id: "old", status: "PASS" as const },
    {
      id: "new",
      status: kind === "reference" ? ("PASS" as const) : ("FAIL" as const),
    },
  ],
});
it("derives nonempty fail/pass groups from two stable behavioral controls", () => {
  const controls = (["base", "reference", "mutant"] as const).flatMap(
    (kind) => [control(kind, 1), control(kind, 2)],
  );
  const result = evaluateCalibration("a".repeat(64), ["old", "new"], controls);
  expect(result.qualified).toBe(true);
  expect(result.passToPass).toEqual(["old"]);
  expect(result.failToPass).toEqual(["new"]);
});
it("rejects stale, flaky, crashing and non-discriminative controls", () => {
  const good = (["base", "reference", "mutant"] as const).flatMap((kind) => [
    control(kind, 1),
    control(kind, 2),
  ]);
  for (const changed of [
    { ...good[0]!, subject_digest: "b".repeat(64) },
    { ...good[0]!, buildPassed: false },
    {
      ...good[0]!,
      checks: [
        { id: "old", status: "PASS" as const },
        { id: "new", status: "PASS" as const },
      ],
    },
  ])
    expect(
      evaluateCalibration(
        "a".repeat(64),
        ["old", "new"],
        [changed, ...good.slice(1)],
      ).qualified,
    ).toBe(false);
});
it("accepts only verified policy-clean completed or functional-fail control artifacts", () => {
  const valid = {
    status: "COMPLETED" as const,
    integrityVerified: true,
    violations: [] as string[],
  };
  expect(() => assertQualificationControlResult(valid)).not.toThrow();
  expect(() =>
    assertQualificationControlResult({ ...valid, status: "FUNCTIONAL_FAIL" }),
  ).not.toThrow();
  for (const result of [
    { ...valid, status: "POLICY_VIOLATION" as const },
    { ...valid, status: "INFRA_ERROR" as const },
    { ...valid, integrityVerified: false },
    { ...valid, violations: ["package.json"] },
  ])
    expect(() => assertQualificationControlResult(result)).toThrow(
      "Invalid qualification control result",
    );
});

it("publishes automated seeded calibration without claiming human review or GOLD", () => {
  const pending = pendingPackage();
  const automated = finalizeQualificationPackage(
    pending,
    "AUTOMATED_DEMO",
    "operator",
    "2026-09-18T00:00:00Z",
  );
  expect(automated.task.quality_tier).toBe("SILVER");
  expect(automated.task.qualified_by).toBeNull();
  expect(automated.approval?.mode).toBe("AUTOMATED_DEMO");
  expect(pending.approval).toBeNull();
  expect(() =>
    assertTaskQualification(automated, benchmark("AUTOMATED_DEMO")),
  ).not.toThrow();
  expect(() =>
    assertTaskQualification(automated, benchmark("HUMAN")),
  ).toThrow();
});

it("keeps explicit human qualification separate from automated execution", () => {
  const human = finalizeQualificationPackage(
    pendingPackage(),
    "HUMAN",
    "reviewer",
    "2026-09-18T00:00:00Z",
  );
  expect(human.task.quality_tier).toBe("GOLD");
  expect(human.task.qualified_by).toBe("reviewer");
  expect(() =>
    assertTaskQualification(human, benchmark("HUMAN")),
  ).not.toThrow();
  expect(() =>
    assertTaskQualification(human, benchmark("AUTOMATED_DEMO")),
  ).toThrow();
});

it("rejects automatic qualification for arbitrary tasks and detached calibration evidence", () => {
  const prepared = finalizeQualificationPackage(
    pendingPackage(),
    "AUTOMATED_DEMO",
    "operator",
    "2026-09-18T00:00:00Z",
  );
  for (const change of [
    { id: "arbitrary-task" },
    { origin: "PRIVATE_HISTORY" as const },
    { suite_role: "HOLDOUT" as const },
    { qualified_by: "invented-reviewer" },
    { quality_tier: "GOLD" as const },
    { pass_to_pass_test_ids: ["some-other-check"] },
  ]) {
    const altered = structuredClone(prepared);
    altered.task = { ...altered.task, ...change };
    expect(() =>
      assertTaskQualification(altered, benchmark("AUTOMATED_DEMO")),
    ).toThrow();
  }
  prepared.approval!.control_digests[0] = "f".repeat(64);
  expect(() =>
    assertTaskQualification(prepared, benchmark("AUTOMATED_DEMO")),
  ).toThrow(/artifact/i);
});

function benchmark(mode: "HUMAN" | "AUTOMATED_DEMO"): BenchmarkLock {
  return {
    schema_version: 1,
    repository_id: "42",
    policy_digest: "b".repeat(64),
    runtime_digest: "c".repeat(64),
    tasks: [],
    dataset_card: {
      origin: "SEEDED_DEMO",
      selection: ["tenant-event-read"],
      excluded: [],
      exposure: "KNOWN_TO_AUTHORS",
      suite: "SMOKE",
      qualification_mode: mode,
    },
  };
}

function pendingPackage(): TaskPackage {
  const file = makeFile("src/app.ts", "base");
  const artifact = {
    id: "a".repeat(64),
    sha256: "a".repeat(64),
    media_type: "application/json",
  };
  const snapshot = {
    title: "Tenant isolation",
    body: "Do not disclose foreign events.",
    captured_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
  };
  const task = freezeRecord<Task>({
    kind: "Task",
    schema_version: 1,
    id: "tenant-event-read",
    repository_id: "42",
    repository_full_name: "owner/demo",
    issue_number: 1,
    pull_request_number: 2,
    issue_node_id: "I_1",
    pull_request_node_id: "PR_2",
    link_evidence_artifact: artifact,
    base_sha: "1".repeat(40),
    reference_sha: "2".repeat(40),
    issue_snapshot_sha256: digest(snapshot),
    prompt_cutoff: snapshot.captured_at,
    source_bundle_sha256: manifestDigest([file]),
    reference_patch_sha256: "a".repeat(64),
    verifier_sha256: "b".repeat(64),
    dependency_lock_sha256: "c".repeat(64),
    application_runtime_digest: "d".repeat(64),
    verifier_image_digest: "image@sha256:" + "e".repeat(64),
    origin: "SEEDED_DEMO",
    visibility: "PRIVATE",
    quality_tier: "SILVER",
    disposition: "ACTIVE",
    history_fidelity: "SNAPSHOT_BEFORE_SOLUTION",
    suite_role: "SMOKE",
    workload: "BUGFIX",
    risk: "CRITICAL",
    component: "tenant isolation",
    exposure: "KNOWN_TO_AUTHORS",
    pass_to_pass_test_ids: [
      "tenant-read.owner-is-200",
      "tenant-read.unknown-is-404",
      "tenant-read.independent-owner",
      "common.health",
    ],
    fail_to_pass_test_ids: [
      "tenant-read.foreign-is-404",
      "tenant-read.foreign-body-redacted",
    ],
    allowed_source_prefixes: ["src/", "tests/agent/"],
    calibration_artifacts: Array.from({ length: 6 }, () => artifact),
    qualified_by: null,
    quarantine_reasons: [],
  });
  return {
    schema_version: 1,
    task,
    prompt: `${snapshot.title}\n\n${snapshot.body}`,
    issue_snapshot: snapshot,
    source: [file],
    reference: [file],
    mutant: [file],
    subject: {
      task_id: task.id,
      repository_id: task.repository_id,
      base_sha: task.base_sha,
      reference_sha: task.reference_sha,
      source_digest: task.source_bundle_sha256,
      reference_digest: task.source_bundle_sha256,
      mutant_digest: task.source_bundle_sha256,
      verifier_digest: task.verifier_sha256,
      runtime_digest: task.application_runtime_digest,
      policy_digest: "b".repeat(64),
      expected_ids: [
        ...task.pass_to_pass_test_ids,
        ...task.fail_to_pass_test_ids,
      ],
    },
    controls: [],
    approval: null,
  };
}
