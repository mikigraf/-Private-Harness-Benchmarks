# Fullbeam Compare — Instacloud + GitHub-native harness evaluation

**Revision:** 2026-09-18, v2.0\
**Status:** Build specification, not a deployed or account-tested integration.\
**Target:** Four-hour proof-of-concept implementation, with explicit scope reductions.\
**Supersedes:** The Daytona/local-job-queue architecture in the earlier four-hour brief.\
**Required execution provider:** Hosted Instacloud at instacloud.com. Do not substitute another sandbox provider.

## 1. Product promise and user

A platform engineer opens a PR changing a shared coding-agent harness. Fullbeam replays a frozen set of historical GitHub issues against the current and proposed harness releases, evaluates the resulting code independently, and attaches an evidence report to that exact PR head commit.

The report answers: **“What did this change break or improve on the work we selected, and what evidence supports that finding?”**

Primary user: the Platform, Developer Productivity, or AI Enablement engineer responsible for shared coding-agent configuration. The first buyer conversation is with the person who owns its rollout and budget. This PoC does not establish willingness to pay.

A harness release includes the native agent client, model/settings, instructions, skills and their resources/scripts, tool configuration, permissions, and stopping policy. A model change is one possible release change, not the whole product.

**Non-promise:** No production-ready certification, autonomous promotion, leaderboard, engineering-productivity measurement, or guarantee that passing a small private benchmark predicts all future work.

## 2. Scope contract

### P0: implement one complete vertical slice

- One explicitly authorized GitHub repository and one native agent adapter: Codex CLI.
- A small reference project with native instructions and skills; real GitHub issues and merged associated PRs created during setup, or equivalent already-existing history.
- Three calibrated cases as the target; one case is the hard minimum if starting entirely from zero.
- Two immutable harness releases; two scheduled attempts per release per task. Three tasks means 12 agent attempts, not 12 distinct workload samples.
- Git-controlled configuration, benchmark membership, qualification policy, and provenance lock.
- GitHub Actions as the trusted controller; Instacloud for generation, build/test execution, and independent verification. No customer-installed runner.
- An explicit maintainer-triggered comparison of a harness PR, issue/PR import, deterministic grading, complete artifacts, and a commit-bound GitHub report.
- One model-only or one harness-only comparison. A bundled change is supported as a bundle, but not causally attributed to an individual component.
- Advisory report only. A human decides what to do next.

### P0.5: only after the vertical slice works

Automatic label-triggered comparisons; a small read-only report page; three additional task cases; richer process diagnostics. A GitHub-native Markdown report and Actions artifacts are sufficient P0 UI.

### Not in this build

Multi-tenant SaaS, an OAuth/install-onboarding backend, arbitrary-repository autodiscovery, automatic trustworthy test generation, cross-harness translation, public ranking, production canaries, billing, model-routing optimization, adversarial sandbox certification, broad deployment tools, or a statistically powered release gate.

A public/demo repository can prove that the machinery works. It cannot establish customer-workload representativeness or release qualification. A seeded project must never be described as customer history.

## 3. Delivery realism

The four-hour target assumes authorized GitHub and Instacloud access, a callable model, a functioning pinned runtime, and a small service without production dependencies. Account setup, missing provider capabilities, or creating and reviewing a credible large historical dataset are not predictable implementation tasks.

If the reference project must also be built and its GitHub history seeded from scratch, finish **one** genuine issue → merged PR → calibrated task → two releases → repeated runs → report path before adding two more tasks. Keep the native harness, real GitHub provenance, and independent verifier. Cut the dashboard, automatic trigger, extra cases, and automated mining first.

Do not silently replace Instacloud, fabricate GitHub identifiers, or call a static mocked report a completed comparison.

## 4. Architecture and trust boundaries

```text
GitHub repository
  AGENTS.md + .agents/skills + .codex config
  .fullbeam release/benchmark/policy declarations
  selected issues + merged reference PRs
             |
Protected GitHub Actions controller
  import -> freeze -> qualify -> schedule
  holds repository/Instacloud control credentials
             |
             +--> Instacloud generation environment A
             |      historical source + current native harness
             |
             +--> Instacloud generation environment B
                    same historical source + candidate native harness
                              |
                    captured candidate outputs
                              |
             Instacloud fresh verification environments
                fixed build + fixed tests + hidden checks
                NO provider or repository credentials
                              |
              immutable report JSON + raw evidence
                              |
            GitHub PR comment / Check Run / Actions artifacts
```

The trusted controller never executes the candidate PR's scripts, dependency hooks, source code, or workflow. It reads them as data and transfers the allowed files into Instacloud. Builds, historical reference execution, mutations, and generated source run remotely.

Maintain separate generation and verifier template projects. They must not be branches of a control project containing gold patches, hidden tests, output archives, or control secrets. Branching copies data as well as services; an empty template is a requirement, not merely an optimization.

No shared writable volumes, reused agent sessions, model memory, or shared mutable package cache across attempts. Read-only preinstalled dependencies are acceptable if identical and hashed.

## 5. Instacloud integration: documented capabilities, not invented APIs

Official documentation currently describes container compute in microVMs, source/image deployment, CLI API-token authentication, branching, and command execution through the `insta_compute_exec` MCP tool. It also documents GitHub-connected deployments and per-PR environments. [S1–S5]

Instacloud's native GitHub connection can deploy the approved sample service or trusted runtime from the protected branch, and optionally a report preview. Keep all preview services credential-free. Evaluation attempts still use explicit historical source and immutable harness/image identities: an automatically deployed current-HEAD preview is not a substitute for replaying the pre-fix task. Do not add a second auto-deployment trigger that evaluates a mutable branch without recording its resolved commit. [S3]

Use a thin internal `InstacloudExecutor` adapter over the pinned CLI and discovered MCP schemas. This is a Fullbeam interface, **not** a claim that an Instacloud SDK exports these functions:

```ts
interface InstacloudExecutor {
  preflight(): Promise<CapabilityReport>;
  createAttemptEnvironment(input: EnvironmentSpec): Promise<EnvironmentRef>;
  putBundle(env: EnvironmentRef, bundle: FileBundle): Promise<void>;
  start(env: EnvironmentRef, input: AttemptInput): Promise<RemoteExecutionRef>;
  poll(ref: RemoteExecutionRef): Promise<ExecutionStatus>;
  collect(ref: RemoteExecutionRef): Promise<ArtifactManifest>;
  destroy(env: EnvironmentRef): Promise<void>;
}
```

`FileBundle` is a bounded list of normalized relative paths, content bytes, sizes, and SHA-256 digests. Reject absolute paths, traversal, duplicate normalized paths, symlinks, hardlinks, special files, excessive expansion, and undeclared files. The reference fixture may use bounded base64 transfer through command execution; large private repositories need a separately designed artifact transport.

Install the trusted supervisor in the runtime image. Start it once per environment, let it write status/result files outside the agent-owned worktree, and poll with short control-plane commands. Do not assume one MCP call can remain connected for the complete model run. Do not expose an unauthenticated general-purpose remote shell HTTP endpoint.

**Mandatory preflight:** authenticate; inspect live MCP tool schemas; create an empty test environment; deploy a pinned image; run a command; round-trip a file and verify its digest; launch a supervised long-running process and poll it; verify native Codex sandbox execution; retrieve outputs; delete the environment and confirm deletion. Check available capacity for at least one generation plus one verification environment. Record the actual CLI version, schema snapshot hash, runtime image digest, region, and observed limits.

Pin `insta` and turn off its documented pre-1.0 auto-update behavior. Resolve exact versions in setup rather than inventing them in the PRD. Deployment inputs and images must be digest-addressed. Keep execution services awake while work runs; scale-to-zero can stop background work. [S1–S2]

Instacloud's documented secrets are environment-injected. They are **not** documented as Daytona-style host-substituted credentials. Never carry over that earlier assumption. [S2–S3]

The model credential stays in a trusted supervisor/proxy context, not the agent shell environment. Use an existing restricted provider gateway where available; otherwise isolate a small single-provider proxy from the unprivileged agent using separate OS users, root-owned files/processes, and no sudo. The child receives only per-attempt model access, not the underlying provider key. Verify that child commands cannot read the proxy's environment or credential files. Restrict endpoints/models and expire access when the attempt ends. This is a demo guardrail, not a hardened multi-tenant vault.

GitHub and Instacloud management tokens never enter generation or verifier environments. Verifiers have no model credential. If these boundaries cannot be demonstrated, mark preflight blocked rather than weakening them silently.

Outbound deny-by-default networking, maximum remote command duration, account-specific concurrency, provider billing granularity, native sandbox compatibility, and TTL enforcement are **not verified against the user's account in this document**. Mark their observed status in the capability report. Without verified egress restrictions, limit P0 to the owned private seeded fixture, disable browsing/GitHub tools, disclose leakage uncertainty, and make no contamination-free or customer-security claim.

Always register environment IDs before submitting work. Use try/finally deletion plus an explicit cleanup action and an orphan sweeper restricted to the recorded run IDs and the Fullbeam resource prefix. Do not assume scale-to-zero deletes resources or makes them free.

## 6. GitOps-native workflow and GitHub integration

### Source of truth

Harness files, benchmark membership, grading policy, and expected source paths live in Git. User-editable GitHub labels initiate intake; they do not independently establish GOLD status. The committed benchmark lock and its calibration evidence are authoritative.

Separate three different kinds of PR:

1. **Historical reference PR:** solves an issue and supplies provenance plus a known implementation.
2. **Benchmark-curation PR:** changes task membership, cutoff, verifier, or policy; requires fresh calibration.
3. **Harness-release PR:** changes the configuration being evaluated; may not weaken the benchmark or verifier used to judge it.

### P0 trigger

Use a `workflow_dispatch` workflow on the protected default branch, taking a candidate PR number. Fetch that PR and its exact head SHA with GitHub's API. This is an intentional maintainer approval step, not a dashboard configuration edit.

The controller resolves the baseline harness from the PR's recorded base SHA and the candidate harness from the recorded head SHA. Freeze the benchmark and policy from the protected default-branch commit selected at dispatch. Record all three identities. Do not accidentally evaluate GitHub's synthetic merge ref instead of the candidate head.

Fetch only allowlisted harness paths from the head. Reject mixed PRs that also change application code or benchmark/policy/grader files in the P0 harness-comparison mode. Supporting a mixed product-plus-harness change is separate scope.

### Automatic trigger after the core works

A maintainer may apply `fullbeam:compare` to an approved same-repository PR. Implement a protected metadata-only trigger that dispatches the trusted controller. Do not check out and execute candidate code in a privileged `pull_request_target` or `workflow_run` job. Forks and untrusted automated actors are excluded from the prototype. Pin trusted actions and controller code by commit. [S8]

Deduplicate on repository ID, head SHA, baseline release digest, benchmark digest, policy digest, and trigger ID. A manual rerun produces a new immutable comparison linked to the old one. New PR commits make previous evidence outdated; they do not mutate the old results.

### Read and write permissions

Controller intake needs Contents read, Issues read, Pull requests read, and Checks/Actions read when collecting historical CI evidence. Publishing can use a separate job with Pull requests write and Checks write. Do not grant Contents write to normal comparisons. The seed/bootstrap operation alone needs separate explicit write privileges.

Within GitHub Actions, use the repository-scoped installation `GITHUB_TOKEN` with declared permissions. This supplies a real GitHub integration without building a public GitHub App onboarding service. A future existing Fullbeam App can implement the same reader/publisher contract. GitHub documents Actions tokens as installation tokens; Checks support commit-bound output. [S9–S10]

Return one updated PR comment, an Actions job summary, JSON and escaped-text artifacts, and optionally a dedicated advisory Check Run. Correctness does not depend on building a new web application.

## 7. Issue/PR ingestion and historical reconstruction

P0 intake starts with an explicit list of one to three issue/PR pairs, optionally selected by `fullbeam:eval-candidate`. Do not scan and auto-certify the entire repository.

Use GitHub's actual closing relation when available. `gh pr view --json` exposes `closingIssuesReferences`, `mergeCommit`, `commits`, `files`, `reviews`, and `statusCheckRollup`. A human-confirmed manifest mapping is acceptable when the relation is missing. Mere mention of an issue is not proof that a PR solves it. Ambiguous multi-issue/multi-PR work is excluded from P0. [S6–S7]

For every imported task record:

- Stable repository ID and full name, issue number/node ID, PR number/node ID, URLs, author/merger and timestamps.
- Link evidence and whether linkage was machine-verified or manually approved.
- Immutable base and accepted commit SHAs; original issue snapshot and hash; prompt cutoff; review/CI evidence and its observed time.
- Changed-file classification, permitted output paths, source/lockfile digests, verifier digest, calibration artifacts, tags, and inclusion/exclusion reasons.
- `origin`, `visibility`, `split`, task-quality tier, and history-fidelity separately.

### P0 commit rule

Use sequential, single-purpose **squash-merged** seed PRs. For these, the accepted merge commit is the gold commit and its parent is the immediate pre-fix base. Confirm the parent and complete diff using Git objects; do not trust the current moving `baseRefOid` to represent the historical pre-fix tree.

The importer supports this narrow form first. Other merge strategies, stacked PRs, unavailable commits, and ambiguous rebases require explicit reviewed base/source-patch mappings or receive `UNSUPPORTED_HISTORY`. A one-parent commit alone does not prove a PR was squash-merged.

### Time-correct prompt

For the seed repository, snapshot the issue immediately before implementing the solution. Preserve that text; later edits and solution comments do not enter the agent prompt.

For real history, current issue bodies are not guaranteed to be their pre-solution versions. Store an available original snapshot, or a reviewed reconstruction marked `RECONSTRUCTED`. Do not label a reconstructed prompt an exact historical replay. A prompt whose ambiguity/leakage cannot be resolved is quarantined.

The agent receives the task requirement and historical source, not reference-PR descriptions, review suggestions, merged diffs, implementation comments, gold tests, or answer-bearing commit messages.

Export the historical source as an archive/file bundle. Remove the original Git object store, refs, remotes, caches, release artifacts, and answer-bearing generated files. Initialize a fresh single-commit repository. Overlay only the chosen harness release. Never copy today's application source into a historical task accidentally.

The historical source is fixed; the harness is deliberately modern/current versus candidate. Label this **historical task replay under present-day harness releases**, not a simulation of exactly what happened on the original date.

## 8. Reference project: RelayDesk

RelayDesk is an owned, deliberately small multi-tenant webhook inbox API. It is a credible workflow fixture, not a production system or a fabricated customer deployment.

Use Node/TypeScript, Fastify, and a deterministic in-memory repository behind a small interface. No frontend, external database, real delivery network, hosted identity provider, or secrets in the dataset. Fixed test clocks and deterministic fixture IDs keep grading portable. Business logic lives in `src/`; compilation and test configuration are controller-owned during evaluation.

The initial API surface is `POST /events`, `GET /events`, `GET /events/:id`, and `GET /health`. Tenant identity is supplied by a documented fixture authentication adapter, not presented as production-grade authentication.

Reference structure:

```text
relaydesk/
  AGENTS.md
  skills.md                          # human index only; not the native loader
  .agents/skills/api-contracts/SKILL.md
  .agents/skills/tenant-safety/SKILL.md
  .agents/skills/verify-change/SKILL.md
  .codex/config.toml
  src/app.ts
  src/events/service.ts
  src/events/repository.ts
  src/events/cursor.ts
  src/auth/fixture-tenant.ts
  tests/public/health.test.ts
  tests/public/events.test.ts
  package.json
  package-lock.json
  tsconfig.json
  Dockerfile
  .fullbeam/release.yaml
  .fullbeam/benchmark.yaml
  .fullbeam/benchmark.lock.json
  .fullbeam/policy.yaml
  .fullbeam/controller/               # protected; never exported to agent
  .fullbeam/private/                  # controls/verifiers; never exported
  .github/workflows/fullbeam-compare.yml
```

For P0, keep the trusted controller and private benchmark payloads under protected `.fullbeam/controller/` and `.fullbeam/private/` directories in the same private demo repository. Generation exports are an explicit allowlist of historical application files and the selected native harness; neither directory, benchmark manifests, workflows, nor original Git history is exported. The benchmark lock contains references/hashes rather than inline gold solutions.

“Hidden” here means unavailable to the agent, not inaccessible to repository maintainers. This seeded SMOKE suite is not a protected holdout. A later customer deployment can separate controller/verifier storage without changing the interfaces. Do not add cross-repository authentication to the four-hour PoC unnecessarily.

### Three target cases

| Stable task ID | Issue requirement | Hidden behavioral evidence | Plausible incorrect mutant |
|---|---|---|---|
| `tenant-event-read` | A tenant must not read another tenant's event by ID. Return 404 without the other tenant's data; the owner must still receive 200. | Owner access, foreign access, unknown ID, response body fields, both tenants' independent records. | Deny every lookup, including the owner's. |
| `tenant-idempotency` | Replaying the same event with the same tenant/key and payload returns the original result without another stored row. A different payload with that key returns 409. Another tenant may use the same key independently. | Stored-count invariants, original response identity, conflict behavior, cross-tenant independence, normal requests without a key. | Deduplicate globally by key while ignoring tenant. |
| `stable-event-pagination` | Page tenant events in ascending `(createdAt,id)` order, without omissions or duplicates when timestamps tie. Reject malformed cursors/invalid limits with 400. | Multi-page traversal, tied timestamps, exact last page, empty set, tenant boundary, cursor validation. | Sort by timestamp only and advance the cursor with a strict timestamp comparison. |

These cases test authorization behavior, data integrity, and API correctness. They are not enough to establish general security, distributed concurrency correctness, or whole-codebase performance.

Three later cases are specified in `reference-project.md`: validation preserving legitimate zero/false values, backward-compatible response shaping, and retry scheduling with a fake clock/transport. They are not part of the mandatory four-hour matrix.

### Seeding GitHub history

Create the repository under an explicitly supplied owner/name. Commit a base implementation, public tests, and the initial native harness. For each case: create a real issue; snapshot it; implement the reference fix and tests on a branch; open a real PR linked with `Closes #<actual-issued-number>`; obtain the chosen human review; squash-merge; record the returned identifiers and commits. Never fabricate independent review when the founder self-reviews.

An idempotent seed script uses a stable marker per issue/PR and resumes without duplicates. It never force-pushes or deletes an existing user repository. Preserve `origin=SEEDED_DEMO` even though these are genuine GitHub objects. Nothing in this delivered specification has created those objects yet.

## 9. Native harness fidelity

Use root `AGENTS.md` for repository instructions and `.agents/skills/<name>/SKILL.md` for actual Codex-discovered skills. A root `skills.md` can index them for humans, but is not interchangeable with the native skill format. Skills have required `name` and `description` metadata; their scripts and references are part of the release. [S11–S12]

The initial shared harness contains general practices, not task-specific answer hints:

- `api-contracts`: inspect existing API behavior, preserve documented status/response semantics, avoid unrelated refactors.
- `tenant-safety`: trace tenant context through reads/writes, check ownership and cross-tenant behavior, avoid recording secrets.
- `verify-change`: reproduce the reported issue, make a minimal change, exercise positive and negative paths, run checks, and report limitations.

For the first harness comparison, keep the model, reasoning effort, permissions, environment, and time budget identical. Change one reviewed general workflow skill or instruction policy. A second comparison can change only the model. Do not tune the candidate on the supposed holdout cases and then call it a holdout result.

Materialize the native file hierarchy. Codex loads project `.codex/` configuration only for trusted projects; the isolated approved fixture must have explicit scoped trust and verified effective settings. A copied config file that is silently ignored is a harness-fidelity failure. Account-wide settings and CLI overrides must be recorded so they do not mask the candidate change. [S16]

Do not concatenate all skills into one prompt or translate Codex configuration into an invented generic agent framework. Use an isolated home directory and record bundled/system components, not the operator's personal installed plugins.

For each component record four evidence fields:

| Field | Meaning |
|---|---|
| `declared` | The frozen release lists the component. |
| `materialized` | Exact expected bytes were present at the expected path. |
| `exposed` | The native client made the component available, where observable. |
| `observed_use` | A concrete trace shows a read/invocation, or `UNKNOWN` when not observable. |

A file being present does not prove the model read or followed it. An observed file read does not prove causal use. Skill use is diagnostic, not the primary quality score.

Pin the CLI version, requested/reported model IDs, native effective settings, instruction and skill-tree digests, tool manifest, runtime image, stopping policy, and environment overrides. Mutable model aliases are explicitly marked. A failed required tool or candidate configuration is a candidate failure, not a quietly omitted component. Native noninteractive Codex supports JSONL events for capturing execution and usage. [S13]

## 10. Qualifying the golden set

“Gold solution” and “GOLD task quality” are different concepts. A merged PR is a reference implementation. GOLD is an earned property of a frozen task/verifier pair.

Use three quality tiers plus a separate disposition:

| Tier | Entry criteria | Permitted use |
|---|---|---|
| BRONZE | Issue/PR provenance exists, but reconstruction or verification is incomplete. | Intake and manual inspection; not a scored headline case. |
| SILVER | Source and reference execute, but a required GOLD condition remains unmet. | Diagnostic runs with the limitation shown; separate from GOLD totals. |
| GOLD | Unambiguous reviewed task, solution-free input, exact source/ref/verifier identities, reproducible controls, meaningful behavioral checks, and a discriminative mutant test. | Scored evidence within the named suite; still not automatic production qualification. |

`disposition` is `ACTIVE`, `QUARANTINED`, or `EXCLUDED`. A formerly GOLD task can be quarantined after a flake, leaked solution, revert, or verifier defect; retain the historical tier/evidence record rather than editing old reports.

### Required GOLD controls

Run each control twice in fresh environments before scoring:

1. **Base plus verifier:** all designated PASS_TO_PASS checks pass; every designated FAIL_TO_PASS check fails for the intended behavior, not missing dependencies or a crashed harness.
2. **Base plus reference source change plus verifier:** every required check passes.
3. **Reference plus a plausible incorrect mutation:** at least the targeted check rejects the mutant; the mutant must still compile/start and fail semantically, not merely crash unrelated setup.

Record expected test IDs, observed counts, exit statuses, assertions, and hashes. A no-op reference or a verifier that passes the base is not GOLD. A missing/skipped test, malformed report, or zero-test success is not a pass. Repetition reduces obvious fixture instability but does not prove absence of flakiness.

The verifier is a behavior contract, not diff similarity. Alternative implementations can pass. A human reviews the requirement-to-assertion mapping and the reference/mutant control, including whether the test encodes an accidental implementation detail.

Historical reviews, CI, absence of observed reverts, and maturity windows are supporting provenance. Unknown CI history or no observed revert is not equivalent to independent proof of correctness. A later revert triggers review/quarantine and a new benchmark revision.

## 11. Labels: separate dimensions, no overloaded badge

Use the machine-readable taxonomy in `benchmark-labels.yaml`.

- **Origin:** `SEEDED_DEMO`, `PRIVATE_HISTORY`, `PUBLIC_HISTORY`.
- **Visibility:** private/public independently of origin.
- **Quality:** BRONZE/SILVER/GOLD, calculated from calibration evidence and approval.
- **History fidelity:** `SNAPSHOT_BEFORE_SOLUTION`, `RECONSTRUCTED`, `UNKNOWN`.
- **Suite role:** `SMOKE`, `REGRESSION`, `HOLDOUT`, `STRESS`.
- **Workload:** `BUGFIX`, `FEATURE`, `REFACTOR`, `MIGRATION`, `TOOLING`; P0 only BUGFIX.
- **Risk:** `STANDARD`, `CRITICAL`; this is the owner's business-risk designation, not a vulnerability classification.
- **Component:** tenant isolation, idempotency, pagination, etc.
- **Exposure:** whether cases/grading evidence have been seen by harness authors or used for tuning.

For GitHub humans, create only the useful intake labels: `fullbeam:eval-candidate`, `fullbeam:eval-exclude`, `fullbeam:compare`, `fullbeam:seeded-demo`, and the component and risk labels used by the example. Derived GOLD status lives in the signed-off lock/report; manually applying a GitHub label cannot bypass qualification.

The three seed tasks belong to a SMOKE suite. Additional repeats do not turn it into a representative regression set. HOLDOUT means the team did not use those tasks or their diagnostics to design the candidate; once exposed for tuning, track that exposure and retire it from untouched holdout status.

Selection is frozen before seeing A/B outcomes. Do not remove tasks because the baseline or candidate performs badly, or select a flattering set after the fact. Record candidate intake, selected tasks, rejected tasks, and reasons in a dataset card. Tag difficulty structurally if needed; do not infer it from which model happens to pass.

## 12. Independent output verification

After the agent stops, capture a filesystem-based output manifest and source diff against the controller-retained base. Include newly created files; do not trust the agent's Git index, declared summary, or self-reported test result.

Allowed submitted changes are `src/**` and optional new `tests/agent/**` files. Agent-written tests are evidence but do not replace the fixed verifier. Existing tests, build scripts, package/lockfiles, TypeScript configuration, harness files, and supervisor files are protected. Reject prohibited changes rather than silently scoring a sanitized partial patch.

In a fresh verifier environment, reconstruct the base; apply validated source changes; restore the fixed build/test setup; install the hidden verifier. Run the candidate service in a separate unprivileged process. For RelayDesk, favor HTTP-level checks owned by the verifier over importing candidate modules into the test-runner process. Keep report writing and the verifier directory out of the candidate's write permissions.

The verifier first checks environment health, then compilation/service startup, then all required PASS_TO_PASS and FAIL_TO_PASS checks. A source-induced compiler error, runtime crash, invalid response, or exceeded task budget is a task failure. A provider provisioning failure or broken verifier transport is an invalid observation, not a model quality failure.

Separate agent budgets from provisioning and grading budgets. Keep source, runtime, region, dependencies, fixtures, clock policy, and verifier equal for paired runs. Generation and verification use separately permissioned processes/images; the application runtime and dependency digests must still match, while the additional trusted verifier layer is recorded separately. Never send hidden verifier feedback back into an ongoing attempt. A repair loop using those tests would be a different declared evaluation protocol.

## 13. Execution and comparison semantics

Three tasks × two releases × two attempts = 12 scheduled agent attempts. Interleave current/candidate order per task and repeat block; persist the schedule and any scheduler seed. This seed controls ordering, not model determinism. Cap concurrent pipelines at two; lower concurrency to actual capacity rather than silently changing machine classes.

Default budgets: 240 seconds of agent execution and 120 seconds of verification per attempt, with separate setup deadlines and an overall job timeout. Configure limits in Git and freeze them. Timeout outcomes remain in the denominator. Repeated runs are independent fresh sessions, not continuations.

Persist attempt records before launch. Never overwrite a failed run with a successful retry. Infrastructure recovery creates a new linked pair/block; preserve the interrupted observations. A missing mate excludes that block from the paired statistic and increments the invalid/missing count; it does not erase the underlying attempt.

### Run result types

`PASS`, `FUNCTIONAL_FAIL`, `REGRESSION_FAIL`, `AGENT_TIMEOUT`, `CANDIDATE_CONFIG_ERROR`, `POLICY_VIOLATION`, `INFRA_ERROR`, `CANCELLED`.

Quality denominator: PASS and all valid task/candidate failures, including timeouts and required candidate tool initialization failures. INFRA_ERROR and CANCELLED are not counted as passes or losses in the paired statistic; they remain prominently reported as missing/invalid evidence. A shared provider outage is infrastructure; a candidate choosing an unavailable or unsupported model/tool configuration can be a configuration failure. Record evidence for the attribution; ambiguous cases are invalid/inconclusive rather than convenient exclusions.

### Task comparison findings with two valid attempts per side

- Current 2/2, candidate 0/2: `REGRESSION_OBSERVED`.
- Current 0/2, candidate 2/2: `IMPROVEMENT_OBSERVED`.
- Both 2/2: `NO_DIFFERENCE_OBSERVED` on measured checks.
- Both 0/2: `SHARED_FAILURE`.
- Any 1/2 pattern: `VARIABLE`.
- Missing or invalid paired evidence: `INCOMPLETE`.

No significance claim attaches to these descriptive labels. Store functional findings even when another task makes the overall comparison inconclusive.

### Comparison findings versus release decision

Keep `comparison_findings[]`, `execution_completeness`, and `release_decision` separate. A completed report can contain both an improvement and a regression. A critical-case loss is never canceled out by a win elsewhere or by lower cost.

P0 `release_decision` is always `NOT_QUALIFIED_FOR_PRODUCTION`. The advisory is `INVESTIGATE_REGRESSION`, `COLLECT_MORE_EVIDENCE`, or `REPAIR_BENCHMARK_OR_INFRASTRUCTURE`, as appropriate. “No observed regression” means all named checks passed on the selected smoke cases, not “safe to deploy.”

## 14. Metrics without misleading denominators

Primary result: per-task successful attempts plus concrete failed checks. Report distinct tasks and repetitions side by side.

For N tasks with all R paired blocks valid, define:

```text
p(config, task) = successful attempts / R
paired difference = mean over tasks of [p(candidate, task) - p(current, task)]
```

Macro-average tasks so tasks with more assertions do not dominate. When paired coverage is incomplete, show the number of eligible tasks/blocks, use a clearly specified complete-case descriptive calculation, and keep the headline inconclusive. Candidate-caused failures are never treated as missing infrastructure data.

Do not publish “pass@2” as a proxy for single-shot reliability. Best-of-k is a different product protocol with its own selection mechanism and cost. Keep all attempts visible.

Secondary metrics: measured agent wall time, provisioning/grading time separately, tokens, usage coverage, and estimated model cost. Include failed attempts in cost. Cost per success is total measured model cost divided by successful attempts, only with complete accounting and nonzero success. Missing data is UNKNOWN; zero successes means unavailable, not zero cost. Provider caching may remain outside operator control; record reported cached usage and do not claim cold-cache equality.

Compare runtime on tasks both configurations solve as a labeled paired-success slice, and show timeouts/failures separately. Do not call a candidate faster simply because it fails early.

Rate records include currency, model identity, effective date, and source. Do not double-count cached input or reasoning tokens already included in output accounting. Instacloud account-cycle usage is not automatically per-attempt compute cost; show it separately or UNKNOWN until measured attribution is implemented. No developer-hour, review-time, DORA, or production-ROI claims in P0.

## 15. Evidence maturity and eventual qualification

Evidence maturity is independent of task GOLD quality:

| Level | Meaning |
|---|---|
| `PIPELINE_DEMO` | Seeded/small public work establishes execution and reporting feasibility. |
| `EXPLORATORY_REPLAY` | Genuine historical work, qualified cases, explicit but limited sample. |
| `WORKLOAD_EVIDENCE` | Defined customer workload, representative sampling, protected holdout, sufficient distinct work and documented uncertainty. |
| `RELEASE_QUALIFICATION` | Predeclared decision policy passes with appropriate evidence, critical guardrails and operational controls; subsequent canary remains a separate step. |

P0 emits PIPELINE_DEMO for RelayDesk, irrespective of how many repeated passes it gets. Do not advance maturity based solely on a fixed count like “30 tasks.”

A later qualification policy must specify workload strata, inclusion/exclusion rules, a quality non-inferiority margin, confidence/uncertainty method that respects task-level clustering, cost target, latency and critical-case guardrails, missing-data policy, and holdout-exposure rules before the experiment. Claiming improvement requires evidence for improvement, not merely failure to detect a regression. Passing tests does not measure reviewer acceptance or production defects; use a separate production canary for those outcomes. [S14–S15]

Keep the existing Fullbeam immutable harness-release/evaluation-contract concepts when present in the actual codebase. This PRD does not claim that the current implementation or database schema was inspected, and does not authorize replacing unrelated production-canary or GitHub evidence flows.

## 16. Report and GitHub check semantics

Report header: repository, candidate PR/head SHA, baseline/candidate release digests, benchmark/policy/verifier/runtime digests, run ID/time, trigger identity, origin, evidence maturity, and sample size.

Then: comparison findings; exact task matrix; cost/time coverage; per-attempt patch, assertions, test IDs, tool events, and qualification controls; exclusions, missing evidence, known leakage limits, and cleanup status.

Required sample report disclaimer:

> PIPELINE_DEMO on 3 seeded tasks, 2 attempts per configuration. Task verification is calibrated; workload representativeness is not established. Not a production-release approval.

A pipeline check named `fullbeam / execution` can succeed when the pipeline completed correctly. A distinct advisory `fullbeam / evidence` check should remain neutral for a smoke-suite pass/inconclusive result, and may mark a confirmed guardrail violation as a failure. Do not configure this advisory as a required production release gate in P0. Github neutral/success statuses are transport/UI states, not scientific confidence. [S10]

A new head SHA invalidates applicability, not the old artifact. The summary always says which commit was evaluated. On cancellation or worker failure, publish incomplete status and cleanup results; never leave a fabricated green badge.

Artifacts are private by default, accessible only through the authorized repository's Actions access or an authenticated existing Fullbeam viewer. Render logs/diffs as escaped text. Hidden verifiers/gold patches are kept separate from generation artifacts and are not exposed through public demo links. Preserve report hashes and the immutable Actions run identity; do not call hashes cryptographic authorship signatures.

## 17. Build sequence and minimum completion

| Work window | Deliverable | Cut rule |
|---|---|---|
| 0:00–0:25 | Instacloud capability smoke test; trusted runtime; GitHub auth; native model access. | If a required capability fails, report the concrete blocker. Do not substitute local execution. |
| 0:25–1:10 | Reference service/harness plus at least one real seeded issue and associated merged PR; three when prepared. | Drop extra cases before dropping real provenance. |
| 1:10–1:45 | Import/freeze; base/reference/mutant calibration; qualification manifest. | Manual approved pair selection; no full-history mining. |
| 1:45–2:45 | Fresh current/candidate runs in Instacloud; independent verification; durable artifacts. | One provider, one native adapter, no database-backed scheduler. |
| 2:45–3:20 | GitHub dispatch, commit-bound report/comment, task matrix, optional advisory check. | No custom SaaS UI required. |
| 3:20–4:00 | Real repeated comparison, negative-path checks, cleanup, recorded demo. | Add label automation or extra cases only after verified core completion. |

Each GOLD case adds six calibration executions (base/reference/mutant, each twice) in addition to its four agent attempts and four independent gradings. Three cases therefore require 18 calibration executions, 12 agent attempts, and 12 output gradings. These are executions, not necessarily 42 newly deployed container images; a pinned clean runtime can be reused as an immutable template, never as a reused writable attempt. Cache calibration only for an exact task/verifier/runtime/policy digest match, retaining its original evidence.

These are implementation allocations, not guaranteed cloud execution times. Twelve worst-case runs plus provisioning can exceed the final window; small fixture runs should start as soon as the runner works, and the overall demo deadline must not change their declared budgets or erase unfinished runs.

Definition of done: a real GitHub harness PR is associated with a frozen current/candidate comparison; at least one actual GitHub issue/merged PR task qualifies; Instacloud runs both native harnesses on identical historical work; an independent verifier evaluates their outputs; all scheduled results and failures are retained; the GitHub report exposes evidence and limitations; resources are cleaned up. Three GOLD seeded cases is the target, not a reason to fake completion.

## 18. Acceptance tests for the Fullbeam pipeline

The following are acceptance requirements, not a statement that tests were executed for this specification:

1. Import rejects an ambiguous issue/PR link and unsupported merge history; seed resume does not duplicate issues.
2. Base fails intended checks; reference passes; plausible mutant fails; changed verifier digest forces recalibration.
3. Hidden files, reference patches, original Git history, and management credentials are absent from generation input.
4. Candidate harness bytes match the head release; current bytes match the baseline; only the allowed dimension changes.
5. Both native skills and their referenced files are materialized; unobservable usage remains UNKNOWN.
6. A source change that edits protected tests/package configuration becomes POLICY_VIOLATION, not PASS or dropped evidence.
7. A zero-test report or absent expected test ID cannot pass.
8. Agent timeout and candidate-required-tool failure remain quality failures; an Instacloud outage is explicitly incomplete evidence.
9. Equal aggregate pass counts with different task failures still show a regression; a critical loss cannot be averaged away.
10. Both 2/2 on every task yields no observed difference and NOT_QUALIFIED_FOR_PRODUCTION, not automatic promotion.
11. Missing cost stays UNKNOWN; failed attempts contribute to measured spending.
12. A rerun preserves original attempts; a new PR head makes previous evidence outdated.
13. Cancellation publishes incomplete status and cleans only the recorded Fullbeam environments.
14. Candidate code is never executed on the privileged Actions controller; provider keys are inaccessible to agent subprocesses.
15. No code, token, gold test, or raw transcript appears in a public report; no negative outcome is replaced with mocked success.

## 19. Sources and verification boundary

Official public documentation checked on 2026-09-18. These sources establish documented interfaces, not that the user's accounts were tested. Product labels, thresholds, architecture, example task requirements, and scope decisions above are proposed Fullbeam design choices.

- [S1] Instacloud CLI: https://docs.instacloud.com/reference/cli/overview
- [S2] Instacloud compute: https://docs.instacloud.com/compute/overview
- [S3] Instacloud deployment / GitHub integration: https://docs.instacloud.com/deploy/overview
- [S4] Instacloud MCP tools: https://docs.instacloud.com/reference/mcp-tools
- [S5] Instacloud storage/branching: https://docs.instacloud.com/storage/overview
- [S6] GitHub issue/PR linking: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- [S7] GitHub CLI PR fields: https://cli.github.com/manual/gh_pr_view
- [S8] GitHub Actions security: https://docs.github.com/en/actions/reference/security/secure-use
- [S9] GitHub Actions token: https://docs.github.com/en/actions/concepts/security/github_token
- [S10] GitHub Checks API: https://docs.github.com/en/rest/checks/runs
- [S11] Native Codex skill discovery: https://learn.chatgpt.com/docs/build-skills
- [S12] Agent Skills format: https://agentskills.io/specification
- [S13] Codex noninteractive execution: https://learn.chatgpt.com/docs/non-interactive-mode
- [S14] Evaluation guidance: https://developers.openai.com/api/docs/guides/evaluation-best-practices
- [S15] SWE-bench evaluation: https://www.swebench.com/SWE-bench/guides/evaluation/
- [S16] Native config precedence/trust: https://learn.chatgpt.com/docs/config-file/config-basic
