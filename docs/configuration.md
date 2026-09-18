# Configure and operate Fullbeam

All required `.env` settings are configured in this workspace. **Hosted runtime preflight is READY**, and real calibration and cancellation/recovery have completed. [Luna](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845) and [Sol](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35400213970) passed strict pipeline acceptance, each with 12 independently graded attempts and confirmed cleanup of 24 fresh environments. Luna passed 5/6 candidate attempts and Sol passed 6/6. Earlier protected-test failures remain recorded; Astra is running. See [acceptance evidence](acceptance.md) and [runtime compatibility](instacloud-runtime-blocker.md).

The supported P0 path uses an owned, private RelayDesk demo repository created or resumed by Fullbeam. An arbitrary existing repository does not become evaluable merely by changing its name in configuration: it needs reviewed historical provenance, a fixed verifier, calibrated controls, and frozen policy. Automatic verifier discovery is not implemented.

## Prerequisites

Use Node.js 24 and npm. Instacloud builds the trusted runtime from source remotely; local Docker and a customer-hosted execution runner are unnecessary. The pinned Instacloud CLI is installed by the root lockfile. GitHub Actions hosts the trusted controller, and Instacloud hosts generation, builds, tests, and independent verification.

Prepare three accounts/credentials:

| Setting                         | What to provide                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FULLBEAM_GITHUB_TOKEN`         | A GitHub classic personal access token or authorized GitHub CLI OAuth token with `repo` and `workflow` scopes. Its user must be able to create the owned private repository and administer branch protection, Actions secrets, and variables. |
| `FULLBEAM_DEMO_REPOSITORY`      | The exact `owner/name` for the dedicated private demo. Use a repository you explicitly own and intend Fullbeam to seed. Existing unrelated repositories are rejected.                                                                         |
| `FULLBEAM_INSTACLOUD_API_TOKEN` | A durable InstaCloud agent credential or API token accepted by `insta --agent login --api-key`, with access to the organization and project/service/branch lifecycle operations.                                                              |
| `INSTA_ORG_ID`                  | The actual Instacloud organization ID.                                                                                                                                                                                                        |
| `FULLBEAM_INSTACLOUD_REGION`    | An available region returned by `insta --agent config regions --json` for the account.                                                                                                                                                        |
| `OPENAI_API_KEY`                | An OpenAI API key with access to the selected model. A ChatGPT subscription is not used as an API credential.                                                                                                                                 |
| `FULLBEAM_MODEL`                | An exact model identifier available to that API account. There is no fabricated default model.                                                                                                                                                |

The bootstrap credential creates and configures repository resources as well as workflows. For an existing GitHub CLI login, authorize `gh auth refresh --scopes repo,workflow`, then store its refreshed token in `.env` without pasting it into chat or logs. Scopes do not grant permissions the token owner lacks, and organization policy may restrict classic PATs. See [GitHub token guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

For unattended InstaCloud access, the supported `insta --agent login --claim your@email.example` flow asks the named user to confirm a code once, then stores a durable agent credential. Put that credential in `FULLBEAM_INSTACLOUD_API_TOKEN`; a browser session or MCP OAuth token is not a substitute. Agent requests retain `--agent` and the provider's governance checks. See [InstaCloud authentication](https://instacloud.com/auth.md) and the local [connection status](instacloud-setup.md).

Default-branch protection is mandatory. Protection on private repositories depends on the account or organization plan; an account that cannot enable it cannot finish this setup. Fullbeam does not silently remove that requirement. See [GitHub protected-branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## One operator configuration file

Run these commands from the Fullbeam checkout:

```sh
npm ci
cp .env.example .env   # Skip this if .env already exists.
```

Edit only the root `.env` for operator configuration. It is gitignored. Existing process environment values override values loaded from `.env`, which allows GitHub Actions to supply the same settings through repository secrets and variables.

Optional settings are:

| Setting                                 | Behavior                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FULLBEAM_REPOSITORY`                   | Normal-operation repository; defaults to `FULLBEAM_DEMO_REPOSITORY`. It must already have the prepared Fullbeam controller and benchmark.                                                        |
| `FULLBEAM_REASONING_EFFORT`             | Initial harness effort, default `medium`; accepted values are `minimal`, `low`, `medium`, `high`, `xhigh`. The selected native client/model must support it.                                     |
| `FULLBEAM_DEMO_MODE`                    | `automated` (default) completes the owned fixture without review prompts and records SILVER/`AUTOMATED_DEMO` evidence. `reviewed` requires explicit human reviews for GOLD qualification.        |
| `FULLBEAM_INPUT_USD_PER_MILLION`        | Operator-supplied input-token rate for `FULLBEAM_MODEL`.                                                                                                                                         |
| `FULLBEAM_CACHED_INPUT_USD_PER_MILLION` | Operator-supplied cached-input-token rate for the same model.                                                                                                                                    |
| `FULLBEAM_OUTPUT_USD_PER_MILLION`       | Operator-supplied output-token rate for the same model.                                                                                                                                          |
| `FULLBEAM_MODEL_RATES_JSON`             | Optional exact-model map of `{ "input": number, "cached": number, "output": number }` rates in USD per million tokens. Takes precedence over the three default-model fields and bundled catalog. |
| `FULLBEAM_MAX_MODEL_COST_USD`           | Positive stop-scheduling threshold, available only when all three rates are supplied.                                                                                                            |

Leave all three legacy rate fields blank to use the bundled catalog where available; partially configuring them is rejected. Rate lookup uses the exact frozen model identifier: first `FULLBEAM_MODEL_RATES_JSON`, then the three fields for `FULLBEAM_MODEL` only, then the bundled standard text-rate catalog. The catalog contains `gpt-5.6-sol`, `gpt-6-astra`, and `gpt-5.6-luna`, dated 2026-09-18. See [rates and sources](dashboard.md#models-and-cost). Unmatched models and incomplete usage retain unknown cost; pricing for one model is never applied to another.

For example, an operator override remains in the same `.env`:

```dotenv
FULLBEAM_MODEL_RATES_JSON={"gpt-5.6-luna":{"input":0.2,"cached":0.02,"output":1.2}}
```

Each new comparison retains the matching rate records, sources, dates, and limitations as immutable evidence. Cached input is deducted from total input before applying the uncached rate. Failed attempts contribute their observed usage. These are standard token-rate estimates, not invoices: infrastructure spend, cache-write tokens, and per-request long-context surcharges are unmeasured. Historical estimates calculated later from a catalog are labeled separately from rates recorded during execution. Review time-limited pricing when planning later runs, and run `npm run setup` after changing rates so Actions receives the updated nonsecret settings.

The spending threshold stops new scheduling after the measured estimate reaches it. It is not a provider-enforced currency cap, and unknown usage cannot enforce an exact monetary limit. Use account-level limits appropriate to the authorized experiment.

The bootstrap PAT remains local. Setup writes only the Instacloud API token and OpenAI API key into their named GitHub repository secrets, and writes nonsecret settings into repository variables. Normal workflows authenticate to GitHub with the repository-scoped `GITHUB_TOKEN`. The root `.env` is never uploaded to an execution branch.

## Setup and the first comparison

```sh
npm run doctor
npm run demo
```

`doctor` reports configuration/runtime readiness and concrete blockers. `setup` creates or resumes dedicated generation and verification template projects, builds the trusted runtime remotely, requires immutable image digests, performs capability preflight, and configures the owned private GitHub repository and protected workflow. These operations create real resources and can incur provider/model charges.

`demo` first runs the idempotent setup, then creates real issue/PR history for three seeded cases, runs remote checks, squash-merges passing owned fixture fixes, dispatches calibration, creates the harness experiment PR, and dispatches its repeated comparison. It saves progress so rerunning the command resumes recorded work. The default automated mode is limited to the exact owned RelayDesk fixture. It records automatic checks as automatic checks, retains SILVER task quality, and makes no human-review or GOLD claim. All base/reference/mutant controls and independent grading remain mandatory.

For human-reviewed qualification, start a fresh owned demo with `FULLBEAM_DEMO_MODE=reviewed` or `npm run demo -- --reviewed`. Inspect each PR diff and remote checks, then enter the displayed approval identity. This records maintainer self-review, not an independent GitHub approving review or production certification. Qualification approval covers the requirement-to-assertion mapping and the repeated base/reference/mutant observations. In a noninteractive shell, reviewed mode stops at the review boundary and prints the exact identity needed to resume. A repository whose seed fixes were already prepared automatically cannot silently switch to human GOLD; use a fresh reviewed demo.

For an existing harness-only PR in the prepared repository:

```sh
npm run compare -- --pr 123
```

Do not use GitHub Actions **Re-run jobs** for a Fullbeam comparison. Run artifacts are immutable within a GitHub run ID, so a manual rerun is rejected before intake or cloud allocation. Retry with a fresh dispatch and link it to the prior comparison: `npm run compare -- --pr 123 --previous <comparison-id>`.

The controller executes from the protected default-branch commit. It reads the candidate's exact head as data and rejects mixed application/controller/benchmark changes. A new PR head requires a new comparison. Two attempts per release per task are retained even when generation, grading, or cleanup fails.

## Dashboard and durable queue

```sh
npm run dashboard          # Prepared repository; npm start is equivalent.
npm run demo:dashboard     # Prepare the owned demo when needed, then open the dashboard.
```

Open **http://127.0.0.1:4318**. Use `npm run dashboard -- --port 4320` to choose another local port. The dashboard uses **InstaCloud Postgres** through `DATABASE_URL` in the same root `.env`. Setup can provision `fullbeam-db` in `FULLBEAM_INSTACLOUD_PROJECT_ID`, or create an owned app project when that ID is omitted, and writes the returned connection setting automatically. Existing connection values are verified and reused. The UI binds to loopback, rejects cross-origin mutations, and keeps GitHub, InstaCloud, OpenAI, and database credentials on the server.

The UI reads real GitHub history and artifacts, shows task/attempt outcomes and token estimates, and compares selected runs or a historical cohort. You can select a model and reasoning effort, edit instructions/native skill files, or select an existing harness PR. A new experiment creates a real PR and evaluates its exact head; it does not automatically merge it. Listing a model for the account does not establish that every reasoning setting is supported.

The selected attempt's **Create draft review PR** action uses the same configured GitHub token. It publishes the exact captured task patch against a separate frozen task/harness snapshot and returns a real draft PR link. It never adds generated application code to the configuration PR or default branch. The server retrieves verified evidence itself; the browser cannot submit replacement source. Unsafe workflow metadata, credential files, or configured secret bytes block publication rather than being silently removed. Review links and input snapshots persist in Postgres; retries reuse verified owned branches and PRs. See [attempt review PRs](attempt-reviews.md).

Requests are saved in InstaCloud Postgres before dispatch. A single local worker waits for the current comparison to finish, then submits the next request. Restarting the dashboard resumes the database queue. Closing it pauses undispatched work; an already-dispatched GitHub workflow continues remotely. A repository-scoped Postgres advisory lock prevents competing workers across processes. Versioned SQL migrations are stored in `migrations/` and applied automatically; the initial migration imports existing local dashboard records once. Database errors are reported without silently switching to a separate local queue.

The worker records a unique dispatch identity before calling GitHub. If the response is lost, it reconciles that identity against GitHub rather than submitting it twice. `dispatch_unknown` means the receipt remains unconfirmed and blocks later queued work until resolved; it is not a completed run or an instruction to rerun the workflow. The queue serializes comparisons; each comparison can still use the two permitted isolated pipelines. See the [dashboard walkthrough](dashboard.md).

## Model and harness experiments

The root `.env` contains credentials and initial model defaults. Evaluated versions keep their model and reasoning effort in `.codex/config.toml`, repository instructions in `AGENTS.md`, and native skills in `.agents/skills/NAME/SKILL.md`. Root `skills.md` is a human-readable index; changing actual skill behavior requires changing the native skill file. Once initialized, changing `.env` defaults does not rewrite an existing release.

Use the dashboard, `harness export`, or `harness propose` to author reproducible experiments; see the [complete authoring guide](harness-experiments.md). Reports classify effective model/reasoning changes as `MODEL_ONLY`, other harness changes as `HARNESS_ONLY`, and both as `BUNDLE`. Bundled results cannot be attributed to one changed component. No second credentials file is needed.

## Operator commands

```sh
npm run fullbeam -- qualify
npm run fullbeam -- report --run-id 123456789
npm run fullbeam -- cleanup
npm run fullbeam -- recover --run-id 123456789
npm run fullbeam -- verify-live
```

`qualify` dispatches calibration or reuses an exact, still-current pending result. Earning GOLD still requires the recorded maintainer approval of valid observations. `report --run-id` retrieves the report associated with the actual GitHub Actions run; it does not create execution evidence. `cleanup` retries recorded local resources. `recover --run-id` uses that run's recorded resource evidence to clean interrupted allocations. The scheduled cleanup workflow also examines recorded completed runs. Cleanup does not indiscriminately delete projects or branches sharing a prefix.

`verify-live` launches a new, potentially billed comparison of the recorded demo PR, then checks the resulting report for three tasks, 12 attempts, complete execution, and confirmed cleanup. It checks pipeline completeness, not an all-pass model result or independent grading of policy-rejected submissions. It requires a completed, qualified demo in either automated or reviewed mode; missing credentials or evidence cannot produce a pass. Run `npm run fullbeam -- --help` for the current command options. Local verification remains separate:

```sh
npm run typecheck
npm test
npm run build
```

To rerun a cancelled demo while retaining its lineage, use `npm run demo -- --previous COMPARISON_ID`. Take that comparison ID from the retained plan or resource journal; it is different from the numeric GitHub Actions run ID. This launches a new immutable comparison and preserves the earlier evidence.

## Frozen runtime, policy, and evidence

The runtime source identity binds the Dockerfile, supervisor, runtime dependencies, historical fixture lock, and native client versions; the runtime identity also binds deployed image digests. Later setup calls reuse the same immutable templates. Source drift invalidates reuse and requires an explicit refresh:

```sh
npm run setup -- --refresh-runtime
```

A refresh provisions a new reviewed runtime identity rather than mutating the meaning of old reports. Recalibrate and approve tasks against the new runtime/verifier/policy before comparison. Retain the old evidence and its original digests.

The frozen P0 policy permits at most two pipelines. Comparisons run up to **two isolated pipelines at a time**, in ordered waves, with a durable checkpoint after each wave. A configured measured-cost threshold selects one worker; calibration controls remain sequential. Agent budget is 240 seconds, verifier budget is 120 seconds, per-attempt setup deadline is 600 seconds, and the main Actions controller deadline is 180 minutes. There are two attempts per release and two repeats for each calibration control. The setup deadline starts before branch allocation and covers bundle transfer and execution launch. The overall attempt deadline uses that same start time, plus the agent/verifier budget and a 60-second collection allowance; cleanup remains enabled after expiry. Initial template bootstrap is separate, with a 15-minute timeout for each remote deployment. Cleanup, publishing, and bootstrap add wall-clock time. These are execution limits, not a promised completion time or exact spend cap.

Runtime and recovery journals remain under `.fullbeam-state/`. Dashboard queue, names, and verified report/task/configuration/code-change snapshots are stored in InstaCloud Postgres. Actions artifacts use 30-day retention; downloaded dashboard history persists in the database after that. Approved calibration objects are additionally archived under `.fullbeam/private/` in the private demo repository so qualification does not silently depend on an expired Actions download. Raw source, transcripts, hidden checks, and calibration assets remain private. Public-facing publication is a sanitized summary bound to an exact commit.

## Recorded evaluations

The configured environment completed strict live acceptance for [Luna](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845) and [Sol](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35400213970). Each comparison retained 12 valid independently graded attempts and 24 cleaned-up environments. Luna's candidate passed 5/6 and Sol's passed 6/6; their separate baselines passed 6/6. Total token estimates were $0.3588647 and $2.35772495, respectively. [Astra](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35402028250) is pending. These observations and cost limitations are documented in [acceptance evidence](acceptance.md); none is a production qualification or statistical model ranking.

## Blocking conditions

| Observation                                                                                      | Required next step                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Missing configuration                                                                            | Fill the named root `.env` fields.                                                                    |
| GitHub repository/protection/secret permission failure                                           | Correct token-owner permissions, organization policy, or account plan support.                        |
| Authenticated MCP discovery fails                                                                | Resolve account access to the hosted MCP; schema evidence cannot be replaced with an invented schema. |
| Image digest, always-on state, sandbox, credential isolation, or deletion cannot be demonstrated | Inspect the saved preflight report and resolve the reported provider/runtime blocker.                 |
| Runtime/verifier/policy digest changed                                                           | Refresh the runtime where appropriate and repeat calibration and approval.                            |
| Cleanup pending or failed                                                                        | Retain the journal and run cleanup/recovery until absence is confirmed.                               |
| No complete report exists                                                                        | Finish a real comparison; do not substitute synthetic tests or a static screenshot.                   |

Outbound egress restrictions remain **UNKNOWN**. P0 is limited to the owned seeded fixture, with native web search and unsupported external tools disabled. Do not interpret this implementation as a customer-security or contamination-free guarantee.
