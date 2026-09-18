export type Outcome =
  | "PASS"
  | "FUNCTIONAL_FAIL"
  | "REGRESSION_FAIL"
  | "AGENT_TIMEOUT"
  | "CANDIDATE_CONFIG_ERROR"
  | "POLICY_VIOLATION"
  | "INFRA_ERROR"
  | "CANCELLED";
export type Finding =
  | "REGRESSION_OBSERVED"
  | "IMPROVEMENT_OBSERVED"
  | "NO_DIFFERENCE_OBSERVED"
  | "SHARED_FAILURE"
  | "VARIABLE"
  | "INCOMPLETE";
export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  complete: boolean;
}
export interface Assertion {
  id: string;
  status: "PASS" | "FAIL" | "SKIP" | "ERROR";
  detail?: string;
}
const valid = (o: Outcome) => o !== "INFRA_ERROR" && o !== "CANCELLED";
export function finding(current: Outcome[], candidate: Outcome[]): Finding {
  if (current.length > 2 || candidate.length > 2)
    throw new Error("Duplicate/extra scheduled observations");
  if (
    current.length !== 2 ||
    candidate.length !== 2 ||
    [...current, ...candidate].some((o) => !valid(o))
  )
    return "INCOMPLETE";
  const a = current.filter((o) => o === "PASS").length,
    b = candidate.filter((o) => o === "PASS").length;
  if (a === 1 || b === 1) return "VARIABLE";
  if (a === 2 && b === 0) return "REGRESSION_OBSERVED";
  if (a === 0 && b === 2) return "IMPROVEMENT_OBSERVED";
  return a === 2 ? "NO_DIFFERENCE_OBSERVED" : "SHARED_FAILURE";
}
export function classifyChecks(
  p2p: string[],
  f2p: string[],
  checks: Assertion[],
): Outcome {
  const expected = [...p2p, ...f2p];
  if (!p2p.length || !f2p.length || new Set(expected).size !== expected.length)
    throw new Error("Invalid expected check groups");
  if (
    checks.length !== expected.length ||
    new Set(checks.map((c) => c.id)).size !== checks.length ||
    checks.some(
      (c) =>
        !expected.includes(c.id) || c.status === "SKIP" || c.status === "ERROR",
    )
  )
    return "INFRA_ERROR";
  if (checks.some((c) => p2p.includes(c.id) && c.status === "FAIL"))
    return "REGRESSION_FAIL";
  if (checks.some((c) => f2p.includes(c.id) && c.status === "FAIL"))
    return "FUNCTIONAL_FAIL";
  return "PASS";
}
export function classifyVerification(
  p2p: string[],
  f2p: string[],
  result: {
    status: string;
    integrityVerified: boolean;
    violations: string[];
    buildPassed?: boolean;
    startupPassed?: boolean;
    failureKind?: "APPLICATION_EXIT" | "VERIFICATION_TIMEOUT";
    checks: Assertion[];
  },
): Outcome {
  if (!result.integrityVerified) return "INFRA_ERROR";
  if (result.status === "POLICY_VIOLATION" || result.violations.length)
    return "POLICY_VIOLATION";
  if (!["COMPLETED", "FUNCTIONAL_FAIL"].includes(result.status))
    return "INFRA_ERROR";
  if (!result.buildPassed || !result.startupPassed) return "FUNCTIONAL_FAIL";
  if (result.status === "FUNCTIONAL_FAIL" && result.failureKind)
    return "FUNCTIONAL_FAIL";
  return classifyChecks(p2p, f2p, result.checks);
}
export interface TaskFindingInput {
  id: string;
  risk: "CRITICAL" | "STANDARD";
  current: Outcome[];
  candidate: Outcome[];
}
export function summarize(tasks: TaskFindingInput[]) {
  const comparison_findings = tasks.map((t) => ({
    ...t,
    finding: finding(t.current, t.candidate),
    current_successes: t.current.filter((o) => o === "PASS").length,
    candidate_successes: t.candidate.filter((o) => o === "PASS").length,
    current_valid: t.current.filter(valid).length,
    candidate_valid: t.candidate.filter(valid).length,
  }));
  const eligible = comparison_findings.filter(
    (t) => t.finding !== "INCOMPLETE",
  );
  const incomplete = eligible.length !== tasks.length || !tasks.length;
  const regression = comparison_findings.some(
    (t) => t.finding === "REGRESSION_OBSERVED",
  );
  return {
    comparison_findings,
    execution_completeness: incomplete
      ? ("INCOMPLETE" as const)
      : ("COMPLETE" as const),
    distinct_tasks: tasks.length,
    repetitions_per_release: 2,
    eligible_tasks: eligible.length,
    eligible_paired_blocks: eligible.length * 2,
    invalid_or_missing_attempts: tasks.reduce(
      (n, t) => n + 4 - [...t.current, ...t.candidate].filter(valid).length,
      0,
    ),
    paired_difference: eligible.length
      ? eligible.reduce(
          (n, t) => n + (t.candidate_successes - t.current_successes) / 2,
          0,
        ) / eligible.length
      : null,
    advisory: regression
      ? ("INVESTIGATE_REGRESSION" as const)
      : incomplete
        ? ("REPAIR_BENCHMARK_OR_INFRASTRUCTURE" as const)
        : ("COLLECT_MORE_EVIDENCE" as const),
    release_decision: "NOT_QUALIFIED_FOR_PRODUCTION" as const,
  };
}
export function estimateCost(
  usage: Usage | null,
  rates: { input: number; cached: number; output: number } | null,
): number | null {
  if (!usage?.complete || !rates) return null;
  if (
    Object.values(rates).some((n) => !Number.isFinite(n) || n < 0) ||
    [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    usage.cached_input_tokens > usage.input_tokens
  )
    throw new Error("Invalid cost accounting");
  return (
    ((usage.input_tokens - usage.cached_input_tokens) * rates.input +
      usage.cached_input_tokens * rates.cached +
      usage.output_tokens * rates.output) /
    1_000_000
  );
}
export function parseUsage(events: string): Usage | null {
  const turns: Usage[] = [];
  for (const line of events.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "turn.completed" && e.usage) {
        const u = e.usage;
        const row = {
          input_tokens: u.input_tokens,
          cached_input_tokens: u.cached_input_tokens ?? 0,
          output_tokens: u.output_tokens,
          complete: true,
        };
        if (
          Object.values(row)
            .slice(0, 3)
            .every(
              (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0,
            )
        )
          turns.push(row);
      }
    } catch {
      /* non-JSON diagnostics remain raw artifacts */
    }
  }
  if (!turns.length) return null;
  return turns.reduce((a, b) => ({
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    complete: a.complete && b.complete,
  }));
}
export function measuredUsage(result: {
  events: string;
  exitCode: number | null;
  logsTruncated: boolean;
}): Usage | null {
  const usage = parseUsage(result.events);
  if (usage) usage.complete = result.exitCode === 0 && !result.logsTruncated;
  return usage;
}
