# Fullbeam implementation ledger

Approved plan: implement the PRD in prd/fullbeam-instacloud-prd, one operator .env, and a real private demo repository. The selected runtime is native Codex on InstaCloud with the operator's OpenAI API key. The automated owned demo records SILVER/`AUTOMATED_DEMO` evidence; the separate reviewed mode retains explicit owner review before seed merges/GOLD. See [automation-plan.md](automation-plan.md).

## Decisions

- Work on feat/fullbeam-compare in the existing checkout; supplied PRD is untracked input and must remain intact.
- Independent implementation domains use separate paths in the shared checkout; root integrates and reviews.
- Runtime provider is exclusively hosted Instacloud. Offline test doubles never become live evidence.
- Mandatory live acceptance cannot be claimed without configured credentials and observed cloud results.
- Exact two attempts per side; recovery creates a new linked comparison, never replaces attempts.
- Companion records extend supplied strict schemas without silently changing them.
- The dashboard shares the root `.env` and uses InstaCloud Postgres for its persistent queue and verified run history. Native execution and independent grading use InstaCloud VMs. Database provisioning/migrations are automated; no second configuration file is needed.
- A completed workflow is distinct from a passing model result. Failed and cancelled observations remain visible and immutable.

## Tasks

- [x] Core contracts/configuration/evidence store and scoring
- [x] RelayDesk fixture, seed revisions, independent checks
- [x] GitHub intake/bootstrap/publishing
- [x] Instacloud adapter and trusted runtime
- [x] Workflow/CLI orchestration and qualification
- [x] Documentation and clean-start verification
- [x] Independent review and integration regression tests
- [x] Git-versioned model/reasoning/skill authoring commands and change classification
- [x] Two isolated comparison workers with durable ordered evidence and cleanup
- [x] Real GitHub harness export/proposal validation (PR #7; proposal not yet evaluated)
- [x] Hosted preflight, real seeded GitHub history, and eighteen calibration controls
- [x] Real cancellation, exact-head incomplete publication, and confirmed recovery
- [x] Linked 12-attempt comparison (Actions run 35397699838): 12 honest `POLICY_VIOLATION` outcomes, all cleanup confirmed
- [x] Same explicit submission policy delivered to both releases, with original issue and full execution-input hashes retained separately
- [x] Local dashboard for real history, attempt/token/cost detail, model/harness experiments, and durable queued dispatch
- [x] Explicit per-attempt draft review PRs with exact frozen task bases, captured code changes, provenance, safe retries, and private stored receipts; real dashboard action published [PR #11](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/11) for the failed Luna attempt
- [x] Per-model immutable pricing records, operator overrides, bundled standard-rate catalog, and unknown-cost limitations
- [x] Fresh Luna comparison after the prompt correction (Actions 35399118845): 12 valid attempts, 24 fresh environments, 11 passes/one functional failure, strict acceptance and cleanup confirmed
- [x] Sol comparison (Actions 35400213970): all 12 attempts passed, 24 fresh environments, strict acceptance and cleanup confirmed
- [ ] Astra comparison (Actions 35402028250) dispatched automatically; result pending, with no inferred score

## Verification boundary

A clean packaged controller was installed with `npm ci --ignore-scripts`, built, and its CLI/configuration checks ran successfully. Live provisioning exposed and corrected compute readiness and repeated supervisor initialization defects. The original hosted runtime failed namespace sandbox preflight. An official Codex 0.125.0 compatibility test subsequently demonstrated native Landlock plus explicit metadata protection in the hosted environment, with all 47 boundary assertions passing. Its rebuilt images passed complete hosted preflight, including an actual model-issued terminal command. All 18 calibration controls passed, and real cancellation/recovery confirmed cleanup.

The earlier linked comparison `35397699838-1-c407be9c` retained all 12 policy failures and confirmed cleanup. Native traces showed protected public-test edits, and no independent verifier was allocated for those rejected submissions. The controller's missing submission instructions were then added equally for both releases without rewriting the original issue or failed evidence.

The subsequent Luna comparison `35399118845-1-711e0f43` completed with all 12 attempts independently graded in 24 fresh environments. The baseline passed 6/6 and Luna passed 5/6; the remaining attempt was a functional failure on tenant idempotency. Strict acceptance recorded `accepted: true`, exact-head publication, and confirmed cleanup. The model token estimate was $0.3588647 with complete cost coverage; infrastructure/invoice totals remain unknown. Report hash: `b64bfa2550373769af9e1ab94632e8ab425c56dd444484614920d1b154b085d4`. This establishes the working seeded evaluation pipeline, not a statistically powered ranking or production approval. The following Sol comparison `35400213970-1-3919f0c3` also passed strict acceptance: baseline 6/6 and Sol 6/6, all 12 independently graded attempts, 24 fresh environments, and confirmed cleanup. Its total model token estimate was $2.35772495 (Sol candidate $2.0771636, baseline $0.28056135), with full coverage. Report hash: `222a17685ddc94b6d20f661cb8b92482d357149cb3ac32f32318df1b828bca39`. Astra run `35402028250` was dispatched next by the queue and remains pending.

Run `npm run dashboard` for the prepared repository or `npm run demo:dashboard` to prepare the owned demo first. The dashboard persists queued requests, reconciles recorded dispatch identities after restart, and reads actual Actions artifacts for progress and history. Model/effort settings remain versioned in `.codex/config.toml`; actual native skills live in `.agents/skills/NAME/SKILL.md`, while `skills.md` is an index. Cost views use matching rate evidence or explicitly labeled historical estimates and exclude unmeasured infrastructure and surcharges.

Local tests use explicit API simulations and local HTTP fixture services; they are not billed model or historical GitHub evidence. Follow [acceptance.md](acceptance.md), the [dashboard guide](dashboard.md), and the [compatibility record](instacloud-runtime-blocker.md) for observed results and remaining live checks; credentials are already configured in the single root `.env`.
