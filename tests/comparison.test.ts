import { it, expect } from "vitest";
import fixtures from "../prd/fullbeam-instacloud-prd/comparison-acceptance-fixtures.json" with { type: "json" };
import {
  finding,
  summarize,
  classifyChecks,
  classifyVerification,
  estimateCost,
  measuredUsage,
  type Outcome,
} from "../src/comparison/summarize.js";
for (const c of fixtures.cases)
  it(`synthetic summarizer: ${c.id}`, () =>
    expect(finding(c.current as Outcome[], c.candidate as Outcome[])).toBe(
      c.finding,
    ));
it("missing slots and extra observations cannot become complete", () => {
  expect(finding(["PASS"], ["PASS", "PASS"])).toBe("INCOMPLETE");
  expect(() => finding(["PASS", "PASS", "PASS"], ["PASS", "PASS"])).toThrow();
});
it("zero/missing/duplicate checks cannot pass and regressions take precedence", () => {
  expect(classifyChecks(["old"], ["new"], [])).toBe("INFRA_ERROR");
  expect(
    classifyChecks(
      ["old"],
      ["new"],
      [
        { id: "old", status: "PASS" },
        { id: "new", status: "FAIL" },
      ],
    ),
  ).toBe("FUNCTIONAL_FAIL");
  expect(
    classifyChecks(
      ["old"],
      ["new"],
      [
        { id: "old", status: "FAIL" },
        { id: "new", status: "FAIL" },
      ],
    ),
  ).toBe("REGRESSION_FAIL");
  expect(
    classifyChecks(
      ["old"],
      ["new"],
      [
        { id: "old", status: "PASS" },
        { id: "new", status: "PASS" },
        { id: "new", status: "PASS" },
      ],
    ),
  ).toBe("INFRA_ERROR");
});
it("keeps critical regression with equal aggregate wins and failures", () => {
  const s = summarize([
    {
      id: "critical",
      risk: "CRITICAL",
      current: ["PASS", "PASS"],
      candidate: ["FUNCTIONAL_FAIL", "FUNCTIONAL_FAIL"],
    },
    {
      id: "improvement",
      risk: "STANDARD",
      current: ["FUNCTIONAL_FAIL", "FUNCTIONAL_FAIL"],
      candidate: ["PASS", "PASS"],
    },
  ]);
  expect(s.paired_difference).toBe(0);
  expect(s.advisory).toBe("INVESTIGATE_REGRESSION");
  expect(s.release_decision).toBe("NOT_QUALIFIED_FOR_PRODUCTION");
});
it("subtracts cached input once; unknown usage remains unknown", () => {
  expect(
    estimateCost(
      {
        input_tokens: 1000,
        cached_input_tokens: 500,
        output_tokens: 100,
        complete: true,
      },
      { input: 2, cached: 1, output: 10 },
    ),
  ).toBeCloseTo(0.0025);
  expect(estimateCost(null, { input: 2, cached: 1, output: 10 })).toBeNull();
});
it("never treats passing checks as permission to accept invalid verifier evidence", () => {
  const result = {
    status: "COMPLETED",
    integrityVerified: true,
    violations: [] as string[],
    buildPassed: true,
    startupPassed: true,
    checks: [
      { id: "old", status: "PASS" as const },
      { id: "new", status: "PASS" as const },
    ],
  };
  expect(classifyVerification(["old"], ["new"], result)).toBe("PASS");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      status: "POLICY_VIOLATION",
    }),
  ).toBe("POLICY_VIOLATION");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      violations: ["package.json"],
    }),
  ).toBe("POLICY_VIOLATION");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      integrityVerified: false,
    }),
  ).toBe("INFRA_ERROR");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      status: "AGENT_ERROR",
    }),
  ).toBe("INFRA_ERROR");
});
it("counts complete native usage from failed policy attempts, but not interrupted streams", () => {
  const events = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 },
  });
  expect(
    measuredUsage({ events, exitCode: 0, logsTruncated: false })?.complete,
  ).toBe(true);
  expect(
    measuredUsage({ events, exitCode: 1, logsTruncated: false })?.complete,
  ).toBe(false);
  expect(
    measuredUsage({ events, exitCode: 0, logsTruncated: true })?.complete,
  ).toBe(false);
});
it("keeps authoritative application crashes and verification deadlines in the failure denominator", () => {
  const result = {
    status: "FUNCTIONAL_FAIL",
    integrityVerified: true,
    violations: [],
    buildPassed: true,
    startupPassed: true,
    checks: [],
  };
  expect(classifyVerification(["old"], ["new"], result)).toBe("INFRA_ERROR");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      failureKind: "APPLICATION_EXIT",
    }),
  ).toBe("FUNCTIONAL_FAIL");
  expect(
    classifyVerification(["old"], ["new"], {
      ...result,
      failureKind: "VERIFICATION_TIMEOUT",
    }),
  ).toBe("FUNCTIONAL_FAIL");
});
