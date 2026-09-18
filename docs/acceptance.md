# Acceptance evidence

## Local verification

These tests verify implementation behavior. They are not historical GitHub or model-performance evidence.

Type checking, tests, build, formatting, and diff checks have passed during implementation. Run the commands below for the current checkout's results rather than treating an earlier test count as evidence for later changes. Tests requiring a local Codex 0.125.0 binary are skipped when that binary is absent; the matching native configuration and skill APIs were exercised in the separate hosted compatibility diagnostic. `doctor --offline` reads recorded preflight evidence and reports a saved blocker instead of treating configured credentials alone as runtime readiness.

The automated-mode update adds current CLI governance/session tests, account preflight, native Codex configuration attestation, metadata guard validation, model/tool receipt checks, failed-preflight evidence retention, and a complete simulated SILVER comparison with 12 attempts and 24 separate generation/verifier executions. These tests are separate from the mandatory live run described below. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run format:check` for current local verification.

| PRD requirement                                                                            | Verification                                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Canonical records, safe bundles, protected paths, evidence integrity                       | `tests/core.test.ts`, `tests/harness.test.ts`                                                                   |
| Real association evidence and narrow squash history                                        | `tests/github.test.ts` using an HTTP API boundary fixture                                                       |
| Seed resume, automated provenance, and exact human approval identities                     | `tests/demo.test.ts`, `tests/product-setup.test.ts`, `tests/account-preflight.test.ts`                          |
| Three reference fixes, discriminative baselines and mutants, exact expected IDs            | `tests/relaydesk.test.ts` running local HTTP services                                                           |
| Human GOLD and automated SILVER controls; stale/malformed calibration rejection            | `tests/qualification.test.ts`, `tests/orchestration.test.ts`                                                    |
| Outcome attribution, critical regressions, missing evidence and cost accounting            | `tests/comparison.test.ts`, `tests/orchestration.test.ts`, supplied eleven synthetic fixtures                   |
| Isolated runtime protocol, bounded transfer, proxy policy, immutable templates and cleanup | `tests/execution.test.ts`, `tests/runtime-setup.test.ts`, `tests/checkpoints.test.ts`, `tests/recovery.test.ts` |
| Protected Actions execution and split publishing permissions                               | `tests/workflows.test.ts`, `tests/controller.test.ts`, `tests/actions.test.ts`                                  |
| Local dashboard, artifact-backed history, queue persistence and dispatch reconciliation    | `tests/dashboard.test.ts`                                                                                       |
| Native harness authoring and semantic model/harness classification                         | `tests/harness-proposal.test.ts`, `tests/harness-export.test.ts`, `tests/harness.test.ts`                       |
| Model-specific rate records, cached-input accounting, and protected-path prompt delivery   | `tests/pricing.test.ts`, `tests/orchestration.test.ts`                                                          |
| Concurrent worker isolation, cleanup failure admission, and immutable checkpoints          | `tests/remote-concurrency.test.ts`, `tests/checkpoints.test.ts`, `tests/orchestration.test.ts`                  |
| Safe Postgres provisioning, one-file credentials, authoritative queue/history persistence  | `tests/database-setup.test.ts`, `tests/dashboard-persistence.test.ts`                                           |

Attempt publication has additional API-boundary coverage in `tests/attempt-review.test.ts`: exact orphan-base diffs, draft creation, repeat-safe recovery, branch ownership, unchanged historical instructions, preserved protected-test edits, and zero-mutation rejection of workflow/credential/secret content.

A clean 114-file protected-controller payload also passed a fresh `npm ci --ignore-scripts`, build, and built CLI/harness help checks, including bundled Postgres migrations, dashboard assets, and the attempt-review publisher. No operator `.env`, authentication files, or private state were included. The live authoring command exported six native files from the protected default branch and created [reasoning-effort proposal #7](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/7), with GitHub confirming only `.codex/config.toml` changed. That proposal is authoring evidence, not an evaluated result.

## Observed live evidence

Recorded on 2026-09-18: all required `.env` settings are configured, the owned [demo repository](https://github.com/mikigraf/fullbeam-relaydesk-demo) has verified branch protection, and the protected controller plus encrypted provider secrets are installed. Hosted runtime preflight is **READY**. After resolving the original namespace incompatibility, rebuilt Codex 0.125.0 images passed 45 boundary assertions per role, native configuration/skill loading, authenticated transfer, detached execution, and deletion. A real model-issued terminal command and nonce-bound receipt verified with the configured OpenAI key. See the [runtime compatibility evidence](instacloud-runtime-blocker.md).

| Evidence                                                                                                    | Observed result                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Qualification 35396054049](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35396054049)   | All 18 base/reference/mutant controls completed successfully; three automated SILVER tasks, no human GOLD claim.                                                                             |
| [Cancellation 35397395579](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35397395579)    | A real environment was allocated before cancellation; exact-head PR #8 received INCOMPLETE publication, and both workflow cleanup and independent recovery confirmed no remaining resources. |
| [Comparison 35397699838](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35397699838)      | All 12 scheduled attempts recorded `POLICY_VIOLATION`, with zero missing observations, zero `INFRA_ERROR`, confirmed cleanup, and successful controller/publication/cleanup jobs.            |
| [Luna comparison 35399118845](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845) | Strict acceptance passed: 12 valid independently graded attempts, 24 fresh environments, 11 `PASS`, one `FUNCTIONAL_FAIL`, exact-head publication, and confirmed cleanup.                    |
| [Sol comparison 35400213970](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35400213970)  | Strict acceptance passed: 12 `PASS` attempts, 24 fresh environments, exact-head publication, and confirmed cleanup.                                                                          |

The earlier policy-failure comparison identity is `35397699838-1-c407be9c`, linked to cancelled comparison `35397395579-1-ebbc8483`. Both releases used `gpt-5.4-mini-2026-03-17` with medium reasoning effort; the recorded change was `HARNESS_ONLY`. All three tasks were `SHARED_FAILURE` with current 0/2 and candidate 0/2. The report recorded approximately **$0.667619** in model token estimates with 12/12 cost coverage; infrastructure and invoice totals remain unknown. Its report hash is `4cc5461e95560f219f5056aaac2a6239c7aebba0c67d956ca3d68968c831edb2`.

Native traces showed that the agents made application changes and also edited protected public tests. The controller had enforced the write policy without supplying its allowed/protected-path instructions in the generation prompt. These are real rejected submissions, not fabricated model results or evidence of a runtime source mutation. The comparison allocated **12 generation environments and no independent verifier environments**: policy rejection occurred before grading. Complete scheduling and cleanup do not establish successful model performance or a full generation-to-verifier path for these attempts.

The controller now gives both releases the same explicit submission policy, preserves the original issue text verbatim, and retains the full execution input and its hash separately from the original prompt snapshot. It directs agent-authored tests to `tests/agent/` and protects existing public tests. Focused regression tests cover that delivery. The subsequent Luna comparison produced 12 policy-valid submissions and completed independent grading. This change does not rewrite the failed run. Comparisons across this correction must disclose the controller difference rather than attributing it solely to a model or skill.

## Completed Luna comparison

Comparison `35399118845-1-711e0f43` evaluated candidate PR **#9**, exact head `a1390473f1b5042d3e7700112ba6cef7e11455aa`, using protected controller commit `32303f11c7cc60a953a068d10a1df0d343b333b6`. It was a `MODEL_ONLY` change from `gpt-5.4-mini-2026-03-17` to `gpt-5.6-luna`, both with medium reasoning effort.

| Task                    | Baseline | Luna candidate | Finding                                    |
| ----------------------- | -------: | -------------: | ------------------------------------------ |
| Tenant event read       |      2/2 |            2/2 | `NO_DIFFERENCE_OBSERVED`                   |
| Tenant idempotency      |      2/2 |            1/2 | `VARIABLE`; one `FUNCTIONAL_FAIL` retained |
| Stable event pagination |      2/2 |            2/2 | `NO_DIFFERENCE_OBSERVED`                   |

All 12 attempts were valid, all six paired blocks were eligible, and execution was `COMPLETE` with zero invalid or missing observations. The baseline passed **6/6**, and Luna passed **5/6**. Every attempt received a fresh generation environment and a fresh independent verifier, for **24 environments**, with cleanup `CONFIRMED`. The report's advisory is `COLLECT_MORE_EVIDENCE`; the two repeats per seeded task do not establish a model ranking.

The retained model token estimate is **$0.3588647** with 12/12 cost coverage. It uses observed usage and matching rates, includes the failed attempt, and excludes unknown infrastructure/invoice totals and unobserved surcharges. Report SHA-256: `b64bfa2550373769af9e1ab94632e8ab425c56dd444484614920d1b154b085d4`.

Strict acceptance at `2026-09-18T22:08:31.402Z` recorded `accepted: true` in the private receipt `.fullbeam-state/acceptance/final-35399118845.json`. It checked all 18 calibration controls, 12 valid attempts, 24 fresh environments, cleanup, and the exact-head GitHub publication. [PR #9's report](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/9#issuecomment-5736773289) has a successful execution check and a neutral evidence check. Qualification remains automated SILVER/`AUTOMATED_DEMO`; release decision remains `NOT_QUALIFIED_FOR_PRODUCTION`.

Historical Luna captures include two unchanged general `AGENTS.md` instruction documents under managed controller-template paths. The old harness resolver selected nested instruction files; no hidden reference implementation or verifier was included. The current resolver excludes managed `.fullbeam/` and `.github/` content except the explicit `.fullbeam/release.yaml` declaration. Attempt-review PRs preserve these already-captured inert instructions exactly, while rejecting new, changed, deleted, or mode-changed managed files. This correction applies to future releases without rewriting old evidence.

The dashboard exposes this retained history and queues real experiments using the same `.env` and InstaCloud Postgres. Sol also completed strict acceptance; Astra remains pending. Available model listings and the separate Responses API probes described in the [dashboard guide](dashboard.md) demonstrate access, not benchmark scores.

## Completed Sol comparison

Comparison `35400213970-1-3919f0c3` evaluated configuration PR **#10**, exact head `8ea0949d47911d9d8f718196c28479ede0ccbf50`, with the same protected controller commit `32303f11c7cc60a953a068d10a1df0d343b333b6` as Luna. It was a `MODEL_ONLY` change from `gpt-5.4-mini-2026-03-17` to `gpt-5.6-sol`, both with medium reasoning effort. Both sides passed **6/6**, including both repeats of all three tasks. All 12 observations were valid, all six paired blocks were eligible, all 24 generation/verifier environments were fresh, and cleanup was `CONFIRMED`.

Strict acceptance at `2026-09-18T22:32:12.927Z` recorded `accepted: true` in `.fullbeam-state/acceptance/final-35400213970.json`, validating all 18 calibration controls and [PR #10's exact-head report](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/10#issuecomment-5736974104). Report SHA-256: `222a17685ddc94b6d20f661cb8b92482d357149cb3ac32f32318df1b828bca39`. Qualification remains automated SILVER and the release remains `NOT_QUALIFIED_FOR_PRODUCTION`.

These are totals for the six **candidate** attempts in each accepted comparison. Input counts include the cached subset; output counts include reported output usage. Costs come from each frozen report's rate evidence and include failed attempts.

| Candidate      | Passed | Input tokens | Cached input tokens | Output tokens | Candidate estimate | Baseline estimate | Full comparison estimate |
| -------------- | -----: | -----------: | ------------------: | ------------: | -----------------: | ----------------: | -----------------------: |
| `gpt-5.6-luna` |    5/6 |    1,821,706 |           1,682,685 |        27,716 |         $0.0947171 |        $0.2641476 |               $0.3588647 |
| `gpt-5.6-sol`  |    6/6 |    1,945,507 |           1,801,029 |        38,942 |         $2.0771636 |       $0.28056135 |              $2.35772495 |

Each comparison has complete 12/12 token-cost coverage. These standard-rate estimates exclude infrastructure charges, invoice reconciliation, cache-write usage, and unobserved long-context surcharges. The separate baseline samples vary; two repeats on three known seeded tasks cannot establish a statistical model ranking. [Astra run 35402028250](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35402028250) was dispatched by the existing queue after Sol completed. Its benchmark result is pending and is not included in this table.

## Captured code review publication

The actual dashboard action created [draft review PR #11](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/11) for Luna's failed tenant-idempotency attempt. All four changed-file contents were checked against the retained generation capture. The PR compares its own frozen task/harness base with that one captured output; protected `main` and configuration PRs #9/#10 were unchanged. Repeating the request reused PR #11. A read-only Postgres audit verified the 12 retained attempt input snapshots and the persisted review receipt against their hashes. The functional failure remains visible in the benchmark report; publishing a review did not turn it into a passing result.

## Repeating live acceptance

Use `npm run demo` (which includes setup), or prepare/open the dashboard with `npm run demo:dashboard` and queue an experiment. `npm run dashboard` opens an already-prepared repository. The Luna run demonstrated the complete generation-to-verifier path; repeat the acceptance checks when changing the runtime or evaluation policy. The full checklist is:

- Actual authenticated MCP schema discovery and successful mandatory capability probes.
- Separate immutable generation/verifier template projects with recorded image digests.
- Three real seed issues, linked squash-merged reference PRs, and original prompt snapshots.
- Eighteen fresh calibration controls; automated mode records SILVER and `AUTOMATED_DEMO`. The optional GOLD path also requires recorded human review.
- A real configuration PR and 12 scheduled attempts; each eligible submission receives fresh independent verification. The Luna run demonstrated all 12 generation-to-verifier paths; the earlier policy-failure run did not.
- Exact-head GitHub report, all negative/incomplete observations retained, and confirmed cleanup.
- Cancellation/recovery exercised against recorded environment identities; no unrelated resources deleted.

A model can fail behavioral checks while the pipeline executes correctly. A comparison with infrastructure errors or missing observations remains incomplete. `verify-live` launches another potentially billed comparison and checks report completeness and cleanup; it does not require all-pass task results or independently establish that policy-rejected attempts were graded. Operator review of the preflight, controls, cancellation exercise, grading evidence, and report remains part of the full acceptance checklist. Every seeded report remains `NOT_QUALIFIED_FOR_PRODUCTION`.

## Intentional P0 boundaries

Comparisons schedule up to two isolated pipelines in ordered waves within the frozen policy maximum. Configured cost thresholds select one worker; calibration controls remain sequential. The dashboard's InstaCloud Postgres queue serializes comparison workflows and resumes after restart; it needs the local process running to dispatch pending requests. The benchmark supports the three owned RelayDesk cases and their recorded history; unsupported history and arbitrary repository imports fail explicitly. Automatic label triggers, production approval, public dashboard hosting, and a general-purpose sandbox fallback are outside this release.

Default-branch protection in the sole-owner demo permits administrative bootstrap writes. Automated fixture preparation and optional human self-review are recorded distinctly; neither establishes independent two-person approval. Hosted egress restrictions, exact infrastructure spend attribution, provider TTL enforcement and hardened multi-tenant isolation are not assumed.
