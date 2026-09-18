import type { Config } from "../core/config.js";
import type { Usage } from "./summarize.js";

export interface ModelRateRecord {
  model: string;
  currency: "USD";
  input: number;
  cached: number;
  output: number;
  effective_at: string;
  source: string;
  limitations: string[];
}
const standardLimitations = [
  "Standard text-token estimate; provider invoice and infrastructure charges are not included.",
  "Native usage does not expose cache-write tokens or per-request long-context pricing; any applicable surcharge is unmeasured.",
];
const entries = [
  ["gpt-5.6-sol", 4, 0.4, 20],
  ["gpt-6-astra", 10, 1, 50],
  ["gpt-5.6-luna", 0.2, 0.02, 1.2],
] as const;
export const VERIFIED_MODEL_RATES: Readonly<Record<string, ModelRateRecord>> =
  Object.fromEntries(
    entries.map(([model, input, cached, output]) => [
      model,
      {
        model,
        currency: "USD",
        input,
        cached,
        output,
        effective_at: "2026-09-18T00:00:00Z",
        source: `https://developers.openai.com/api/docs/models/${model}`,
        limitations: standardLimitations,
      },
    ]),
  );
export function resolveModelRate(
  config: Pick<Config, "model" | "rates" | "modelRates">,
  model: string,
): ModelRateRecord | null {
  const operatorRate =
    (config.modelRates && Object.hasOwn(config.modelRates, model)
      ? config.modelRates[model]
      : null) ?? (model === config.model ? config.rates : null);
  if (operatorRate)
    return {
      ...operatorRate,
      model,
      currency: "USD",
      effective_at: new Date().toISOString(),
      source: "operator-configured .env",
      limitations: standardLimitations,
    };
  return Object.hasOwn(VERIFIED_MODEL_RATES, model)
    ? structuredClone(VERIFIED_MODEL_RATES[model]!)
    : null;
}
export function tokenCostBreakdown(
  usage: Usage | null,
  rate: Pick<ModelRateRecord, "input" | "cached" | "output"> | null,
) {
  if (
    !usage?.complete ||
    !rate ||
    usage.cached_input_tokens > usage.input_tokens ||
    [
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens,
      rate.input,
      rate.cached,
      rate.output,
    ].some((n) => !Number.isFinite(n) || n < 0)
  )
    return null;
  const uncachedInputUsd =
    ((usage.input_tokens - usage.cached_input_tokens) * rate.input) / 1_000_000;
  const cachedInputUsd = (usage.cached_input_tokens * rate.cached) / 1_000_000;
  const outputUsd = (usage.output_tokens * rate.output) / 1_000_000;
  return {
    uncachedInputUsd,
    cachedInputUsd,
    inputUsd: uncachedInputUsd + cachedInputUsd,
    outputUsd,
    totalUsd: uncachedInputUsd + cachedInputUsd + outputUsd,
  };
}
