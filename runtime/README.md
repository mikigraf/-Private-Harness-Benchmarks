# Trusted Instacloud runtime

This directory is deployed only from the protected controller checkout into two
separate, empty Instacloud projects. The runtime accepts bounded supervisor argv
commands through authenticated `insta --agent compute exec`; its HTTP listener is a fixed
health response, never a shell. Runtime images must resolve to `@sha256:` identities.

The Node 24.20.0 Docker base index digest was retrieved from Docker Hub on 2026-09-18.
Codex is pinned to the official `0.125.0` release. Its documented native legacy
Landlock backend is selected by `features.use_legacy_landlock=true`; this upstream
feature is deprecated. The newer Bubblewrap backend could not create namespaces
in the tested hosted environment. A disposable hosted compatibility test proved
Landlock workspace writes, outside-workspace write denial, root credential
isolation, no new privileges, and the metadata protections described below.
Every rebuilt image must pass the complete preflight independently.

The capability command uses `codex sandbox linux --full-auto`: in this version,
the sandbox debug command otherwise overrides `sandbox_mode` with read-only mode.
Generation uses `codex exec --sandbox workspace-write --ephemeral`, with approval
policy `never`. Both commands use the same explicit Landlock feature. See the
[official feature](https://github.com/openai/codex/blob/rust-v0.125.0/codex-rs/features/src/lib.rs#L773-L778),
[debug mode selection](https://github.com/openai/codex/blob/rust-v0.125.0/codex-rs/cli/src/debug_sandbox.rs#L590-L625),
and [native enforcement](https://github.com/openai/codex/blob/rust-v0.125.0/codex-rs/linux-sandbox/src/landlock.rs#L34-L84).

Each branch executes once. A detached root supervisor keeps uploaded inputs,
model credentials, status, and reports outside the writable workspace. Generation
runs as uid 10001; application builds/servers run as uid 10003; a separately
uploaded, digest-verified grader runs as uid 10002. The agent receives only an
expiring per-attempt loopback token. The proxy accepts POST `/v1/responses` for one
model, disallows hosted tools/background requests, and holds the real model key in
its root process. No GitHub or Instacloud management credential is sent remotely.

Landlock provides the native workspace boundary. The versioned supervisor guard
`unix-metadata-v1` separately seals `.git/`, `.codex/`, `.agents/`, and existing
root `AGENTS.md` and `skills.md` as root-owned and non-writable, preserving exact
bytes and executable bits. The root-owned workspace has mode `1777`, so the agent
cannot rename or replace those root-owned entries. Sealing rejects symbolic links,
hardlinked files, and special files. Other protected paths, including nested
instructions, source policy, and build files, remain subject to authoritative
before/after manifest enforcement; they are not all made filesystem-immutable.
Preflight tests actual metadata content/chmod/removal/rename/symlink replacement
denial, successful source writes, an outside-workspace write positive control,
and native `NoNewPrivs` and empty effective capabilities. The trusted root reads a
generated assertion receipt because nested command stdout was not reliably
returned in the hosted compatibility test. Failed or missing evidence blocks readiness.

Files are individual normalized records with exact byte counts and hashes, never
archives. Uploads and artifact downloads are paginated at 24 KiB. Source capture
includes untracked/new files, deletions, and executable modes, refuses links and
special files, and records prohibited changes. Fixed generated `dist/`, fresh
`.git/`, and immutable `node_modules/` are explicitly excluded from source
submission; fresh verification never receives those directories. Dependency
installation uses the frozen lockfile remotely with lifecycle scripts disabled.

Capability preflight must observe real authenticated provider schemas, matching
child images, always-on services, empty template secrets/state, both environment
roles concurrently, native filesystem sandbox enforcement, credential
unreadability, transfer roundtrip, detached execution, a native model/proxy smoke
run, paged output retrieval, and deletion. Failure blocks readiness. Egress,
provider TTL, billing granularity, and stronger adversarial isolation remain
UNKNOWN until separately demonstrated. Local unit tests do not establish cloud
capability or a completed comparison.

The supervisor's own `@iarna/toml` dependency is pinned in this directory's lockfile
and installed as root in `/opt/fullbeam`. It parses the actual frozen native
configuration and checks that the requested model/reasoning match. It then asks
the pinned native Codex app server (`--listen stdio://`) for `config/read` and `skills/list`, without a
model credential or inference call. A disabled project layer, mismatched effective
settings (including the native Landlock feature), or missing expected native skill
blocks generation. This release has no `--strict-config` flag: evidence reports
`strictConfig: false`, and the supervisor explicitly accepts only the five frozen
model, reasoning, approval, sandbox, and web-search settings and requires exact
native project-layer equality. Loaded settings,
configuration layers, and skill discovery are retained as evidence; materialized
files retain exact hashes. Discovery establishes availability, while actual skill
use remains UNKNOWN without trace evidence. An image/source change
requires a new runtime identity and fresh task qualification.

The application dependencies are installed inside each remote branch with
`npm ci --ignore-scripts` from the frozen application lock, then made root-owned
and read-only. Application execution and hidden grading use different UIDs.
The verifier receives `TARGET_URL` and `FULLBEAM_TASK_ID`; the application receives
`RELAYDESK_FIXED_TIME` and `RELAYDESK_ID_PREFIX`. Generation never receives the
hidden grader module.

The adapter checks template secret inventory and child image/always-on evidence,
then uses deterministic branch identities recorded before allocation. Collected
results include status, durations, before/after source manifests, explicit
exclusions, policy violations, native events/usage, and independent checks.
Deletion is verified through the provider's branch listing; uncertain cleanup
remains recorded for recovery. See [configuration](../docs/configuration.md) and
[architecture](../docs/architecture.md) for account prerequisites, review steps,
command usage, retention, and the limits of the seeded P0.
