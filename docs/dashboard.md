# Dashboard and live demo

Run from the Fullbeam checkout with the existing root `.env`:

```sh
npm ci
npm run dashboard
```

Open **http://127.0.0.1:4318**. `npm start` is equivalent. To prepare an owned demo repository first, use `npm run demo:dashboard`. On a fresh account this performs real provisioning, history creation, and calibration; it can take time and incurs model/infrastructure usage. Existing qualified repositories are reused.

The dashboard connects to the configured private repository using the server's GitHub token and stores its queue and retained run evidence in **InstaCloud Postgres**. Native Codex and independent verifiers run in **InstaCloud VMs**. Provider credentials, including `DATABASE_URL`, stay in the server's single root `.env`. The UI binds to the local machine; it is not an unauthenticated public hosted service. Use `npm run dashboard -- --port 4320` if the default port is occupied.

## Demo walkthrough

1. Open the dashboard and confirm the connected GitHub repository and available models.
2. Inspect past runs. Cancelled, incomplete, failed, and successful observations remain visible. A completed workflow is not necessarily an all-pass model result.
3. Select a run and inspect task outcomes, individual attempts, input/output tokens, and cost breakdowns. The task and configuration views show frozen inputs and harness files; the changes view shows the actual agent patch. Configuration PR links point to GitHub. Use **Create draft review PR** on an attempt to review its exact patch on GitHub, linked to this evaluation. See [attempt review PRs](attempt-reviews.md).
4. Compare it with a selected earlier run or the historical cohort. Review task-level differences as well as aggregate counts; a small repeated fixture is not a statistically powered ranking.
5. Create a new run, select a model and reasoning effort, and optionally edit harness instructions or native skill content. The app creates a real configuration PR, then evaluates its exact head. An existing harness PR can also be evaluated.
6. Watch queued/running status and observed progress update automatically. Completion loads the report into the same history and charts.

Keep the local dashboard process running to dispatch queued work. An already-dispatched evaluation continues in GitHub Actions if the app closes; restarting the app resumes the Postgres queue without duplicating its dispatch. Completed queued evaluations and reports viewed in the app are retained in Postgres, bound to their original repository, run identity, and report hash. Existing local dashboard records are imported once. The database holds task/configuration/code-change views beyond GitHub's 30-day artifact retention. Raw Actions artifacts that expired before download remain unavailable rather than becoming invented results. Preserve `.fullbeam-state/` for the separate runtime and recovery journals.

The demo never generates synthetic historical successes. The retained history includes the intentional cancellation test and early policy-failure observations. Those early attempts modified protected public tests because the controller had failed to include the allowed-write instructions in its native prompt. Subsequent controller versions explicitly provide the same submission policy to both releases, keep the original issue text verbatim, and retain the full execution input and hash. Do not attribute a difference across that controller correction solely to the model or skill change.

## Models and cost

The configured account was checked on 2026-09-18: `gpt-5.6-sol`, `gpt-6-astra`, and `gpt-5.6-luna` were listed and each answered a real Responses API request. This access probe is not benchmark evidence; task results come from the separate native Codex evaluations in InstaCloud.

Verified standard text rates per million tokens:

| Model        |  Input | Cached input | Output | Source                                                                             |
| ------------ | -----: | -----------: | -----: | ---------------------------------------------------------------------------------- |
| GPT-5.6 Sol  |  $4.00 |        $0.40 | $20.00 | [Official model rates](https://developers.openai.com/api/docs/models/gpt-5.6-sol)  |
| GPT-6 Astra  | $10.00 |        $1.00 | $50.00 | [Official model rates](https://developers.openai.com/api/docs/models/gpt-6-astra)  |
| GPT-5.6 Luna |  $0.20 |        $0.02 |  $1.20 | [Official model rates](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |

The run records its rate snapshot. Recorded input tokens include cached input: cached tokens are subtracted before applying the uncached rate, so they are not charged twice. Output tokens include billed reasoning output where reported by the native client.

Displayed costs are **token-rate estimates**, not provider invoices. Native aggregate usage does not expose every cache-write token or per-request long-context tier; applicable surcharges remain unmeasured. Infrastructure spend is also unknown. Missing usage or unmatched pricing is shown as unknown, never zero. Historical estimates computed later from a catalog are labeled separately from rates frozen during execution.

Optional per-model overrides still go in the same root `.env`:

```dotenv
FULLBEAM_MODEL_RATES_JSON={"gpt-5.6-sol":{"input":4,"cached":0.4,"output":20},"gpt-6-astra":{"input":10,"cached":1,"output":50},"gpt-5.6-luna":{"input":0.2,"cached":0.02,"output":1.2}}
```

Explicit per-model overrides take precedence over the default model's three legacy rate fields and the verified catalog. Run `npm run setup` after changing settings so GitHub Actions receives the updated nonsecret rates. Models without configured or catalog rates retain unknown costs. Review rates when provider pricing changes; Sol's published promotional rates are time limited.

See [configuration](configuration.md), [harness authoring](harness-experiments.md), and [acceptance evidence](acceptance.md) for the execution boundaries and retained live run identities.
