import { digest } from "../core/integrity.js";
import type { Assertion } from "../comparison/summarize.js";
export interface CalibrationControl {
  kind: "base" | "reference" | "mutant";
  repeat: 1 | 2;
  subject_digest: string;
  buildPassed: boolean;
  startupPassed: boolean;
  checks: Assertion[];
}
export interface QualificationSubject {
  task_id: string;
  repository_id: string;
  base_sha: string;
  reference_sha: string;
  source_digest: string;
  reference_digest: string;
  mutant_digest: string;
  verifier_digest: string;
  runtime_digest: string;
  policy_digest: string;
  expected_ids: string[];
}
export const qualificationSubjectDigest = (
  subject: QualificationSubject,
): string => digest(subject);
export function evaluateCalibration(
  subjectDigest: string,
  expectedIds: string[],
  controls: CalibrationControl[],
) {
  const reasons = new Set<string>();
  let p2p: string[] = [],
    f2p: string[] = [];
  if (!expectedIds.length || new Set(expectedIds).size !== expectedIds.length)
    throw new Error("Expected IDs must be nonempty and unique");
  if (
    controls.length !== 6 ||
    new Set(controls.map((c) => `${c.kind}-${c.repeat}`)).size !== 6
  )
    reasons.add("FLAKY_CONTROL");
  for (const c of controls) {
    if (c.subject_digest !== subjectDigest) reasons.add("VERIFIER_DEFECT");
    if (!c.buildPassed || !c.startupPassed)
      reasons.add("UNREPRODUCIBLE_ENVIRONMENT");
    if (
      c.checks.length !== expectedIds.length ||
      new Set(c.checks.map((x) => x.id)).size !== expectedIds.length ||
      c.checks.some(
        (x) =>
          !expectedIds.includes(x.id) || !["PASS", "FAIL"].includes(x.status),
      )
    )
      reasons.add("MISSING_TESTS");
  }
  const base = controls.filter((c) => c.kind === "base");
  const reference = controls.filter((c) => c.kind === "reference");
  const mutants = controls.filter((c) => c.kind === "mutant");
  if (base.length === 2) {
    p2p = expectedIds.filter((id) =>
      base.every((c) => c.checks.find((x) => x.id === id)?.status === "PASS"),
    );
    f2p = expectedIds.filter((id) =>
      base.every((c) => c.checks.find((x) => x.id === id)?.status === "FAIL"),
    );
    if (p2p.length + f2p.length !== expectedIds.length)
      reasons.add("FLAKY_CONTROL");
    if (!p2p.length || !f2p.length) reasons.add("BASE_NOT_DISCRIMINATIVE");
  } else reasons.add("FLAKY_CONTROL");
  if (
    reference.length !== 2 ||
    reference.some((c) => c.checks.some((x) => x.status !== "PASS"))
  )
    reasons.add("REFERENCE_FAILS");
  if (
    mutants.length !== 2 ||
    mutants.some((c) => !c.checks.some((x) => x.status === "FAIL"))
  )
    reasons.add("MUTANT_NOT_DISCRIMINATIVE");
  if (
    mutants.length === 2 &&
    expectedIds.some(
      (id) =>
        mutants[0]!.checks.find((c) => c.id === id)?.status !==
        mutants[1]!.checks.find((c) => c.id === id)?.status,
    )
  )
    reasons.add("FLAKY_CONTROL");
  return {
    qualified: reasons.size === 0,
    passToPass: p2p,
    failToPass: f2p,
    reasons: [...reasons],
  };
}
