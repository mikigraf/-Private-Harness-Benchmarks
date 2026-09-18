# Fullbeam Compare — Instacloud/GitHub specification pack

**Created:** 2026-09-18. **Status:** Design artifacts, not a built/deployed application.

Start with `PRD.md`, then `reference-project.md` and `integration-contracts.md`.

## Included

| File | Purpose |
|---|---|
| `PRD.md` | Full product requirements, Instacloud/GitHub architecture, trust boundaries, scope, qualification, metrics, build sequence, and acceptance criteria. |
| `reference-project.md` | RelayDesk API/seed-history requirements and exact behavioral test IDs for three cases. |
| `integration-contracts.md` | Implementation modules, frozen-record semantics, provider adaptation, result attribution, and publishing rules. |
| `benchmark-labels.yaml` | Orthogonal benchmark taxonomy, intake labels, quality gates, result enums, and P0 policy defaults. |
| `record-contracts.schema.json` | JSON Schema for the proposed frozen release/task/comparison/run records. |
| `comparison-acceptance-fixtures.json` | Eleven clearly synthetic summarizer test cases, not model performance results. |
| `harness-template/` | AGENTS.md, human skills.md index, native Codex config, and three native SKILL.md files. |
| `validation-report.json` | Checks of these document assets only; does not represent application/integration tests. |

## The build boundary

Required: real GitHub issue/PR provenance, native harness releases, Instacloud execution, independent calibrated verification, complete observations and commit-bound reporting. Target three tasks with two attempts per configuration; preserve one complete real case rather than faking three.

Deferred: automatic label trigger, custom dashboard, arbitrary repository import, cross-harness translation, and production qualification. Use GitHub Actions dispatch/reporting instead of building a new scheduler.

No GitHub issues or PRs were created by producing this pack. No Instacloud project was provisioned, model was called, source application was implemented, or live integration was verified. Native templates are examples that require the pinned CLI's preflight; they contain no account-specific model identifier or credentials. The JSON fixtures are not benchmark evidence.

External sources are listed in the PRD. Task tiers and evidence-maturity labels are proposed Fullbeam product rules, not external certifications.
