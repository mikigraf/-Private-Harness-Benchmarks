# Fullbeam — implementation boundaries and frozen records

**Status:** Interface specification. No live Instacloud schemas, GitHub identifiers, model IDs, credentials, or execution outcomes are fabricated here.

## 1. Work units and files to implement

| Module | Input | Output / responsibility |
|---|---|---|
| `github/intake.ts` | Authorized repo identity and explicit issue/PR pairs | Verified association evidence and raw API snapshots; reject ambiguous history. |
| `github/freeze.ts` | Historical Git objects and issue snapshot | Solution-free source manifest, base/reference identities and controller-only reference patch. |
| `harness/resolve.ts` | Commit plus allowlisted native harness paths | Frozen HarnessRelease, native component inventory and effective-settings evidence. |
| `benchmark/qualify.ts` | Task, runtime, verifier, controls | Calibration observations and earned quality tier, never a manually trusted GOLD badge. |
| `execution/instacloud.ts` | Capability-checked provider connection | Create, transfer, supervise, poll, collect, delete; provider schemas discovered live. |
| `execution/attempt.ts` | Frozen task, release and schedule item | Durable attempt lifecycle, captured changes, independent grading, cleanup. |
| `grading/relaydesk.ts` | Historical source plus submitted allowed changes | Fixed build and HTTP behavior checks in separate verifier permissions. |
| `comparison/summarize.ts` | Frozen schedule and all attempt observations | Per-task findings, complete/missing counts, cost coverage, bounded advisory. |
| `github/publish.ts` | Safe report plus exact candidate head SHA | Updated PR comment, Actions summary/artifacts, optional separate evidence Check Run. |

Place these modules under protected `.fullbeam/controller/` for the single-repository PoC, or reuse existing Fullbeam equivalents. Never execute modules fetched from candidate HEAD on the trusted Actions controller. The caller may submit known IDs/PR numbers only, not arbitrary shell commands or artifact paths.

## 2. Records and application-level checks

`record-contracts.schema.json` defines frozen HarnessRelease, Task, Comparison and completed Run records. In-progress intake/state may use separate internal records; do not invent SHAs to satisfy a frozen-record schema prematurely.

Application validation must additionally enforce:

- All IDs belong to the same authorized repository and intended frozen comparison; every scheduled task/release digest resolves.
- Every record digest is recomputed from its canonical semantic payload, not accepted as a user-provided assertion. SHA-256 hashes are integrity identifiers, not signatures.
- Task expected check IDs are unique and PASS_TO_PASS and FAIL_TO_PASS sets do not overlap. P0 requires both groups to be nonempty.
- GOLD requires current control evidence and a qualification approver. A stale verifier/runtime/policy digest or quarantine condition makes the task unscorable without rewriting old reports.
- Every scheduled task has exactly two current and two candidate attempts; block IDs pair current/candidate repeats. A retained retry has a new ID and links to, rather than replaces, the previous result.
- Start/end times are ordered; all measured quantities are nonnegative; cost is null unless a matching rate record and adequate usage accounting exist.
- PASS requires all expected checks present, unskipped and passing, valid build/startup, no prohibited change and verified output integrity. A check log alone is not an authoritative report if a candidate can rewrite it.
- Pipeline completeness, task findings, release decision and cleanup status are separate fields. A complete report can describe a failed candidate.

Canonical record hashing: serialize JSON as UTF-8 with object keys sorted recursively, arrays in their declared order, no insignificant whitespace, and no non-finite numbers. Exclude the record's own digest and volatile transport URLs. Hash exact source/harness bytes separately; do not normalize away meaningful newlines or script mode changes. Include file mode in the source manifest. A release must bind all native component files/resources, environment/settings/permission policy and client/runtime identities.

The JSON schema encodes syntax and basic required fields, not these relational or semantic guarantees. Synthetic IDs or hex strings in unit tests must remain clearly marked test data and never enter a real report.

## 3. Instacloud adapter implementation protocol

First call the actual hosted MCP tool listing with authorized credentials and store a schema hash. Implement against the returned schemas for project/branch/deploy/compute command/status/delete operations. The public tool names establish discovery targets, not argument objects that this specification can safely invent.

Use the pinned `insta` CLI for documented deploy/lifecycle actions when that is shorter; disable automatic CLI updates and capture its version. Never assume `insta run` is a generic remote sandbox-exec API. The execution adapter owns the documented remote compute-exec transport and the image's trusted supervisor protocol.

A generation template has only the approved runtime/supervisor and model-access boundary. A verifier template has the same application runtime/dependencies plus trusted grader components, without model access. No template contains reference patches, prior results, task-specific hidden tests, GitHub credentials, Instacloud credentials, or control-project storage. Upload per-task contents after creating the environment.

For the tiny PoC, transfer bounded normalized file records through authenticated command execution, with byte-size limits and final manifest verification. For larger content, use authenticated object transfer with strict object scoping. Never assume an arbitrary archive is safe to extract. Candidate filenames, issue bodies and log content are data, not shell syntax.

The trusted supervisor creates the unprivileged agent process and records timestamps/status/output outside the worktree. Start returns an execution ID promptly; poll retrieves bounded status chunks, collect returns artifact IDs/digests. No open general-purpose HTTP shell is needed. The controller owns termination and cleanup even when the native agent exits abnormally.

Actual remote-command limits, egress restrictions, native sandbox compatibility, resource sizing and cost attribution are capability-test results. Missing mandatory capability is a blocking preflight observation. No sample function or nominal machine specification proves it works in the account.

## 4. GitHub authentication and trust

The normal run uses GitHub Actions' repository-scoped token, Contents read and metadata read, plus narrowly scoped report-publishing writes. Bootstrap is a separate explicitly authorized write operation. Do not make the ordinary evaluator capable of merging PRs or changing the repository's benchmark policy.

P0 workflow_dispatch runs the controller from protected default branch and takes candidate PR number. Fetch head/base and benchmark-policy refs, freeze them, and use those exact identities throughout. Candidate files are data even when they include native agent configuration or skill scripts; all their execution remains inside Instacloud.

A candidate PR that modifies verifier/policy/controller files is not a harness-only comparison and is rejected. Candidate harness code cannot supply the test command, trusted executable paths, provider management credentials, or result-publishing destination.

Attach evidence to the exact head SHA. A refreshed head needs a new comparison. The advisory check is not required for production merge during the PoC. Sanitize Markdown and render raw outputs as escaped text; do not execute HTML from reports or logs.

## 5. Outcome attribution and precedence

If generation setup fails because of a shared provider incident, record INFRA_ERROR. If the candidate selects an unsupported required model/tool, record CANDIDATE_CONFIG_ERROR when attribution is supported; otherwise mark ambiguous/incomplete. Never reclassify an inconvenient candidate failure as infrastructure without evidence.

Source-induced compile/startup errors are FUNCTIONAL_FAIL. FAIL_TO_PASS assertion failures are FUNCTIONAL_FAIL; PASS_TO_PASS failures are REGRESSION_FAIL. When both groups fail, use REGRESSION_FAIL and retain both failure sets. Modified protected tests/build settings are POLICY_VIOLATION. A budget expiry is AGENT_TIMEOUT, not missing data.

`comparison-acceptance-fixtures.json` supplies eleven synthetic cases for a pure summarizer test. They are not runtime/model measurements. Findings compare pass counts, while the report preserves the cause: a timeout regression is not the same claim as an observed behavioral defect.

Aggregate advisories use this order for display: preserve any observed regression and its evidence; separately flag invalid/missing comparisons; otherwise ask for more evidence. No observed improvement erases a critical-case loss. P0 never emits production approval regardless of these descriptive findings.

## 6. Evidence, spend and execution records

Save raw native event streams, source manifests, generated changes, verifier reports, controls, runtime identities, provider-schema snapshot, observed component availability, and cleanup records. Logs must be access-controlled and scrubbed for credentials before publishing. Hidden grader feedback is not routed back to a still-running attempt.

Do not count a command trace saying “tests pass” as verification. Do not infer skill use from its presence. When a skill cannot be observed as exposed/read, record UNKNOWN rather than manufacture a telemetry signal.

Include failed attempt spending. Report estimated model cost separately from unallocated Instacloud usage. A run-count/time limit is not an exact currency budget. Enforce provider-side limits where available and abort new scheduling when a declared limit is reached; preserve existing incomplete records. Rate-table changes cannot retroactively alter the originally published estimate without a separately versioned recalculation.

Retain the genuine completed report as a saved demo with run ID/timestamp. A replay is fine when labeled as a replay; it is not a live run.
