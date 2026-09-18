import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  resolveModelRate,
  tokenCostBreakdown,
} from "../src/comparison/pricing.js";
describe("model-specific rate snapshots", () => {
  it("loads per-model overrides from the same env and rejects malformed prices", () => {
    const env = {
      FULLBEAM_GITHUB_TOKEN: "test",
      FULLBEAM_DEMO_REPOSITORY: "owner/repo",
      FULLBEAM_INSTACLOUD_API_TOKEN: "test",
      INSTA_ORG_ID: "org",
      FULLBEAM_INSTACLOUD_REGION: "us-east",
      OPENAI_API_KEY: "test",
      FULLBEAM_MODEL: "baseline",
    };
    const configured = loadConfig({
      ...env,
      FULLBEAM_MODEL_RATES_JSON:
        '{"gpt-5.6-sol":{"input":3,"cached":0.3,"output":12}}',
    });
    expect(resolveModelRate(configured, "gpt-5.6-sol")?.input).toBe(3);
    for (const value of [
      "[]",
      '{"gpt-5.6-sol":{"input":-1,"cached":0,"output":1}}',
      '{"gpt-5.6-sol":{"input":1}}',
    ])
      expect(() =>
        loadConfig({ ...env, FULLBEAM_MODEL_RATES_JSON: value }),
      ).toThrow("FULLBEAM_MODEL_RATES_JSON");
  });
  const config = {
    model: "baseline",
    rates: { input: 1, cached: 0.1, output: 5 },
  };
  it("uses matching operator prices and verified candidate prices without borrowing baseline rates", () => {
    expect(resolveModelRate(config, "baseline")?.source).toBe(
      "operator-configured .env",
    );
    expect(resolveModelRate(config, "gpt-5.6-luna")?.input).toBe(0.2);
    expect(resolveModelRate(config, "unpriced")).toBeNull();
    expect(resolveModelRate(config, "toString")).toBeNull();
  });
  it("separates paid input, cached input, and output without double-counting cache", () => {
    const rate = resolveModelRate(config, "gpt-5.6-sol");
    expect(
      tokenCostBreakdown(
        {
          input_tokens: 1_000_000,
          cached_input_tokens: 250_000,
          output_tokens: 100_000,
          complete: true,
        },
        rate,
      ),
    ).toEqual({
      uncachedInputUsd: 3,
      cachedInputUsd: 0.1,
      inputUsd: 3.1,
      outputUsd: 2,
      totalUsd: 5.1,
    });
    expect(
      tokenCostBreakdown(
        {
          input_tokens: 1,
          cached_input_tokens: 2,
          output_tokens: 1,
          complete: true,
        },
        rate,
      ),
    ).toBeNull();
    expect(
      tokenCostBreakdown(
        {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          complete: false,
        },
        rate,
      ),
    ).toBeNull();
  });
});
