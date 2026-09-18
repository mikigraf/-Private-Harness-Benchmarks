# Fullbeam Compare

Compare models, reasoning settings, instructions, and native Codex skills against frozen historical GitHub tasks. The local dashboard queues real GitHub Actions evaluations; hosted InstaCloud runs each agent attempt and independent verification of eligible submissions. Reports attach to the exact candidate PR commit.

This repository implements the [PRD](prd/fullbeam-instacloud-prd/PRD.md). The supported first product is a private, owned RelayDesk benchmark with three calibrated cases. It is an advisory pipeline demonstration, not production-release certification.

**Live evidence (2026-09-18):** Both [Luna comparison 35399118845](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845) and [Sol comparison 35400213970](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35400213970) passed strict pipeline acceptance. Each retained 12 valid independently graded attempts, 24 fresh environments, exact-head publication, and confirmed cleanup. Luna passed **5/6** candidate attempts; Sol passed **6/6**; their baselines each passed **6/6**. Total model token estimates were **$0.3588647** and **$2.35772495**, respectively; infrastructure/invoice totals remain unknown. All 18 calibration controls and the separate cancellation/recovery exercise also passed. [Astra evaluation 35402028250](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35402028250) is pending. These small seeded samples do not establish a model ranking. See [acceptance evidence](docs/acceptance.md).

## Configure one file

Requirements: Node 24, npm, a GitHub account able to administer a private repository with branch protection, Instacloud access, and an OpenAI API key with a callable model.

```sh
npm ci
cp .env.example .env   # Skip this if .env already exists.
```

Fill in the seven required settings in `.env`:

```dotenv
FULLBEAM_GITHUB_TOKEN=
FULLBEAM_DEMO_REPOSITORY=your-owner/your-private-demo
FULLBEAM_INSTACLOUD_API_TOKEN=
INSTA_ORG_ID=
FULLBEAM_INSTACLOUD_REGION=
OPENAI_API_KEY=
FULLBEAM_MODEL=
```

Then:

```sh
npm run doctor
npm run demo:dashboard
```

Open **http://127.0.0.1:4318**. `demo:dashboard` prepares and qualifies the owned demo when needed, then opens the dashboard. For a prepared repository, use `npm run dashboard` or `npm start`. The dashboard shows real run history, task outcomes, input/output tokens, estimated costs, and comparisons with earlier runs. It can create a model/harness PR and queue its evaluation. Pending requests survive local restarts; keep the server running to dispatch them. See the [dashboard walkthrough](docs/dashboard.md).

Select an individual attempt and choose **Create draft review PR** to publish its captured code changes for GitHub review. Each attempt gets its own frozen task base and draft PR; the configuration PR and benchmark results remain unchanged. [Draft review PR #11](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/11) is the real captured Luna failure. See [attempt review PRs](docs/attempt-reviews.md).

`npm run demo` runs the complete command-line demo, including setup and a comparison. Setup installs the private repository workflows, nonsecret policy and runtime locks, and encrypted Actions secrets. It remotely builds the trusted runtimes and requires a real provider capability preflight. InstaCloud Postgres stores the dashboard queue and retained reports; InstaCloud VMs run native Codex and independent verification. Database provisioning writes `DATABASE_URL` into the same `.env`. You do not need local Docker or another hand-edited configuration file. `npm run setup` remains available to prepare infrastructure separately.

Demo mode creates real issues and reference PRs, runs checks in InstaCloud, squash-merges passing fixture fixes, calibrates the hidden verifier with base/reference/mutant controls, opens a harness-only PR, and runs 12 actual Codex attempts using your OpenAI API key. Re-running the command resumes recorded progress. `FULLBEAM_DEMO_MODE=automated` is the default and requires no review prompts. Its reports explicitly identify automated SILVER fixture qualification; they never claim human review or GOLD evidence. Use `npm run demo -- --reviewed` for the human-reviewed path.

Provider account authorization is a one-time prerequisite. After `.env` is configured, repository setup, runtime provisioning, evaluations, reporting, and cleanup are automated. Offline tests and synthetic summarizer fixtures are never reported as model results. The dashboard binds to loopback and keeps provider credentials on the server.

## Normal operation

After the repository is prepared, create a model experiment or export and edit its instructions and native skills:

```sh
npm run fullbeam -- harness propose --name model-experiment --model YOUR_MODEL_ID
npm run fullbeam -- harness export --out .fullbeam-state/my-harness
# Edit the exported files, then:
npm run fullbeam -- harness propose --name skill-experiment --overlay .fullbeam-state/my-harness
```

See [model and harness experiments](docs/harness-experiments.md) for model settings, `AGENTS.md`, `skills.md`, native `SKILL.md` files, and report interpretation. Evaluate the resulting PR:

```sh
npm run compare -- --pr 123
npm run fullbeam -- report --run-id 123456789
```

`FULLBEAM_REPOSITORY` optionally selects another already-prepared repository. Arbitrary repository discovery and automatic trustworthy verifier creation are outside this P0 release.

The report shows each task and attempt, assertion failures, paired coverage, model cost coverage, provenance, commit applicability, and cleanup status. Both improvements and regressions remain visible. Every P0 report retains `NOT_QUALIFIED_FOR_PRODUCTION`.

Token costs use a frozen rate record for each model, with optional overrides in the same `.env` and a bundled standard-rate catalog for Sol, Astra, and Luna. Missing usage or pricing stays unknown. Estimates exclude infrastructure, invoice reconciliation, and unobserved cache-write or long-context surcharges. See [pricing configuration](docs/configuration.md#one-operator-configuration-file).

```sh
npm run demo -- --replay 123456789       # Explicit replay of saved real evidence
npm run demo -- --previous COMPARISON_ID # New demo comparison linked to an earlier one
npm run fullbeam -- qualify             # Run/review calibration
npm run fullbeam -- cleanup             # Reconcile locally recorded resources
npm run fullbeam -- recover --run-id 123456789
npm run fullbeam -- verify-live         # Run another real acceptance comparison
```

See [configuration and operations](docs/configuration.md), [architecture](docs/architecture.md), [runtime boundaries](runtime/README.md), and the [acceptance checklist](docs/acceptance.md).

## Development checks

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests exercise real local RelayDesk behavior and simulated external API boundaries. The live acceptance command needs configured accounts and an approved seeded benchmark. Model generation, historical replay and qualification in the product use Instacloud exclusively; there is no local or mocked demo fallback.

Private dashboard history and retained task/configuration/change snapshots are stored in InstaCloud Postgres; runtime journals remain in `.fullbeam-state/`, and original execution evidence is retained in repository Actions artifacts. Generation never receives original Git history, controller code, reference patches, hidden verifiers, or management credentials. See the architecture guide for the precise boundaries and the remaining egress limitations.
