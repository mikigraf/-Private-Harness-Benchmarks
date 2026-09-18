import { describe, expect, it } from "vitest";

import { assertFirstWorkflowAttempt } from "../src/product/controller.js";

describe("trusted controller run identity", () => {
  it("rejects a GitHub manual rerun before immutable artifact names can collide", () => {
    expect(() => assertFirstWorkflowAttempt("1")).not.toThrow();
    expect(() => assertFirstWorkflowAttempt("2")).toThrow(
      /fresh comparison.*--previous/i,
    );
    expect(() => assertFirstWorkflowAttempt("invalid")).toThrow(
      /invalid github actions run attempt/i,
    );
  });
});
