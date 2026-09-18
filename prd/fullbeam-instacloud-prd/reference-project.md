# RelayDesk — reference project and seeded benchmark specification

**Purpose:** An implementable, owned demonstration of the Fullbeam evaluation loop. This file specifies a project to build; it is not a claim that the service, GitHub issues, reference PRs, or verifiers already exist.

## 1. Minimal service contract

Use one TypeScript package on a pinned supported Node runtime, Fastify, a lockfile, and no networked dependencies at runtime. The in-memory repository is intentional: this is an isolated behavior fixture, not a durable production webhook product. Bind to the supplied PORT and expose `/health` for setup checks.

`Event` contains `id`, `tenantId`, `type`, `payload`, and `createdAt`. Public JSON omits `tenantId`; the fixture authentication adapter supplies it from the required `X-Tenant-Id` header. Document this header as test authentication, not a secure production identity mechanism. Missing tenant header is 401 for business endpoints. `/health` is unauthenticated and returns 200 with `{ "ok": true }`.

- `POST /events`: JSON object with nonempty string `type` and object `payload`. Optional `Idempotency-Key` header. First accepted event returns 201 and `{ "event": { "id", "type", "payload", "createdAt" } }`. Exact key/payload replay returns 200 and the same event. Conflicting reuse returns 409. Validation failures return 400 without a write.
- `GET /events/:id`: the tenant's event or 404 with `{ "error": "not_found" }`. Foreign-tenant and absent IDs have the same external response.
- `GET /events?limit=N&cursor=C`: default limit 20, valid integers 1–100. Returns `{ "events": [...], "nextCursor": string | null }`, sorted ascending by `(createdAt,id)`. Invalid limit or malformed cursor returns 400. Cursors are opaque to callers; tests assert observable traversal, not a particular encoding.

Use canonical recursive object-key ordering for idempotency payload comparison so object property insertion order is not business meaning. Array order remains significant. Include `type` and `payload` in the comparison. A key is scoped to tenant. Replays do not create a new ID or timestamp. Cursor semantics must remain tenant scoped; an event from a different tenant is not observable even when a cursor was obtained elsewhere.

A fixed injected clock and deterministic unique IDs support reproducible fixtures. These are controlled by the test bootstrap, not source hooks the evaluated agent is allowed to change. Each verifier starts from a fresh process/store; fixture construction is outside the measured request window.

Repository-owned scripts to implement: `npm run build` (TypeScript compile), `npm test` (public tests), and `npm start` (compiled server). Pin the actual resolved dependencies and container image after the first successful runtime build; do not invent version strings in a task manifest.

## 2. Seed the history honestly

Implement the small baseline service with deliberate, documented seed defects. Generic instructions/skills should already be in the baseline before creating issues. Add each fix as a sequential single-purpose squash PR so its accepted merge commit and parent have a simple historical relationship.

The bootstrap operation takes one explicit authorized repository, checks its identity, and writes a seed ledger with stable task IDs. Before creating anything, look for the stable task marker in an existing ledger/issue to make resume idempotent. It must not create issues in an unrelated repository or close/merge user work.

For each seed case: create the issue; save its exact body and update timestamp before solution work; create a branch; implement the accepted change and ordinary public tests; open a PR with a real closing relation; run checks; explicitly squash merge the owned seed PR; retrieve and store the resulting issue/PR node IDs, merge SHA, parent SHA, and API evidence. Re-fetch and confirm the association. Do not invent IDs, reviews, CI success, or historical timestamps. Mark every seed record `origin: SEEDED_DEMO`, even though the GitHub objects are real.

Write hidden acceptance tests and semantic mutants as controller-only benchmark assets, review them, and run the calibration controls. Reference patches contain source changes only. Public tests authored in the reference PR are not available in the pre-fix agent snapshot; they can be incorporated into the separately frozen verifier if appropriate.

## 3. Cases and exact behavioral checks

Names below are canonical test IDs. Assign each check to FAIL_TO_PASS only if it actually fails semantically on the chosen base. Already-passing checks belong to PASS_TO_PASS. Qualification observes this distinction; it must not assume every interesting test fails the base.

### A. `tenant-event-read` — CRITICAL, tenant isolation

Issue: “An authenticated tenant must not retrieve another tenant's event by ID. A legitimate owner's lookup must continue to work. Return the same 404 error for foreign and unknown IDs.”

| Check ID | Assertion |
|---|---|
| `tenant-read.foreign-is-404` | Tenant B requesting tenant A's ID receives 404. |
| `tenant-read.foreign-body-redacted` | Error body contains no event fields/payload or tenant identifier. |
| `tenant-read.owner-is-200` | Tenant A receives its exact event. |
| `tenant-read.unknown-is-404` | Unknown ID has the same status and shape as foreign ID. |
| `tenant-read.independent-owner` | B can still retrieve its own distinct event. |
| `common.health` | Server is healthy under the fixed runtime. |

Seed defect: lookup uses event ID without tenant ownership enforcement. Reference fix: scope lookup to caller tenant. Semantic mutant: deny every lookup. The mutant still builds/starts and must be rejected by positive owner-access checks, proving the verifier does not reward “deny everything.”

### B. `tenant-idempotency` — CRITICAL, data integrity

Issue: “Repeated delivery with the same tenant and idempotency key must not create duplicates. Preserve the original response identity. Conflicting reuse returns 409. Different tenants can reuse the same key independently.”

| Check ID | Assertion |
|---|---|
| `idempotency.same-request-one-row` | Two identical requests yield one stored event. |
| `idempotency.replay-stable-response` | Replay returns original ID, type, payload, timestamp with 200. |
| `idempotency.conflict-is-409` | A changed type/payload with the same tenant/key returns 409 without a write. |
| `idempotency.tenant-scoped-key` | Another tenant's same key creates that tenant's own event. |
| `idempotency.keyless-independent` | Keyless requests retain ordinary creation behavior. |
| `idempotency.object-order-equivalent` | Object-key insertion order alone does not create a conflict. |
| `idempotency.array-order-significant` | Reordered array payload is a conflicting payload. |
| `tenant-read.foreign-is-404` | Previously accepted isolation behavior remains intact. |

Seed defect: requests always append an event. Reference fix: tenant-scoped key lookup and deterministic payload comparison. Semantic mutant: global key lookup without tenant scope. Test stored count through tenant-visible API results, not private map representation.

### C. `stable-event-pagination` — STANDARD, pagination

Issue: “Paginate a tenant's events in ascending creation time with ID tie-breaking. A traversal must return each event exactly once, including events sharing a timestamp. Reject invalid cursor/limit inputs.”

| Check ID | Assertion |
|---|---|
| `pagination.tie-no-omission` | Traversing several pages containing tied timestamps omits no IDs. |
| `pagination.no-duplicates` | Each event ID appears once across the complete traversal. |
| `pagination.stable-order` | Observable order is ascending by `(createdAt,id)`. |
| `pagination.final-cursor-null` | Last page ends with null cursor, including exact page multiples. |
| `pagination.empty` | Empty tenant gets empty events and null cursor. |
| `pagination.invalid-input-400` | Bad encoding and limits 0, -1, 101, 1.5 or nonnumeric return 400. |
| `pagination.tenant-isolation` | Other tenants' events never appear in a traversal. |
| `idempotency.same-request-one-row` | Prior accepted idempotency behavior remains intact. |

Seed defect: use timestamp-only cursor progression. Reference fix: complete ordering key and validated cursor. Semantic mutant: retain timestamp-only comparison at the page boundary. The verifier must detect the omission; it must not require a particular cursor byte representation or implementation helper name.

### Additional cases after the core

Validation that preserves meaningful zero/false values; backward-compatible response shape when adding an optional field; deterministic retry timing with fake clock/transport. These expand behavior coverage but do not turn a seeded fixture into real customer workload evidence. Do not build real outbound webhook delivery or a queue just to add the retry case.

## 4. Native harness contents

The `harness-template/` directory in this pack provides `AGENTS.md`, a human `skills.md` index, and three native `.agents/skills/<name>/SKILL.md` files. They describe general engineering practices, not the seed cases or reference answers.

The template also includes a minimal `.codex/config.toml` for noninteractive workspace-write execution with web search disabled. Verify these settings and scoped project trust using the pinned native CLI during runtime setup. Freeze it with the release. Account-specific model identity and provider setup are required external inputs, not fictional defaults. Store secrets outside this file.

The release resolver inventories root/nested AGENTS files, the entire skill directories including scripts/references, native configuration, effective environment overrides, native client version, permissions, required tools, and execution limits. It overlays only this harness onto each historical source snapshot, not the current application code or the current public tests.

First comparison: change the general verification workflow skill while holding model/settings/budget fixed. The existing skill may say “run the documented checks”; the proposed general change can require explicit positive and negative behavior checks and honest verification limitations. This is a declared workflow-policy experiment, not evidence that the change will win. Once the authors inspect results and tune the skill, these same tasks are exposed development/regression cases—not an untouched holdout.

## 5. Preflight checklist and evidence limits

A real benchmark is ready only after the runtime builds, the ordinary tests run, native skill discovery behaves as recorded, issue/PR associations resolve, and base/reference/mutant controls produce the intended results twice. An account token and a plausible folder tree are not sufficient.

Mark initial task tier BRONZE while intake is pending. GOLD is derived after observed calibration and review. Mark the suite SMOKE, known to authors, and PIPELINE_DEMO. No outcome is hardcoded to make one release better. A tie is an acceptable demo.

This document does not include a working application, a deployed runtime, or fabricated output from one. It gives the implementing engineer an exact service/test contract, native harness templates, and a GitHub seeding procedure that must be executed under the owner's authorization.
