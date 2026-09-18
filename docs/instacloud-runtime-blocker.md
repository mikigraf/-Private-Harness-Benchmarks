# Hosted native runtime compatibility

Observed on 2026-09-18. All required root `.env` settings are configured. The original Codex 0.153.2 namespace failure is retained below. The replacement Codex 0.125.0 runtime completed mandatory hosted preflight at **2026-09-18T21:10:43Z with status READY**. Subsequently, [Luna comparison 35399118845](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845) passed strict pipeline acceptance: 12 valid independently graded attempts, 24 fresh environments, 11 passes, one functional failure, and confirmed cleanup. See [acceptance evidence](acceptance.md) for calibration, cancellation, and exact report identities; runtime readiness alone is not a benchmark score.

## Rebuilt runtime preflight

Both freshly built roles passed 45 boundary assertions each, native configuration and skill loading, metadata protection, credential isolation, and no-new-privileges checks. Authenticated transfer, detached execution, concurrent roles, immutable image identity, and deletion were verified. Using the configured `gpt-5.4-mini-2026-03-17` and operator OpenAI API key, native Codex executed `node fullbeam-probe.cjs`; its native command event and nonce-bound receipt both verified.

| Role         | Project                                | Image digest                                                              |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| Generation   | `8bded125-21f4-445c-b822-67f0c76f4555` | `sha256:22b918a58062bd3184ac89352a1db574dcb775483662a11c0be289500caa41e5` |
| Verification | `548ba0ee-64b6-4b4c-9aee-baf14971ce5e` | `sha256:900a3f192a6dd260161f5d7ed6fe3ce9c7247ed7852431f94008f2d6fdb88619` |

Runtime source digest: `e5b57f34bf0c58bce8d0f87877a1ccc2ef36184c982e06eeed006b7119732eeb`. Application/runtime digest: `72c13194b81c3fa7cfd8f49b8d617e128d7ca3c3595d3f6a850c6c1163f9641e`. Full evidence is in `.fullbeam-state/evidence/preflight.json` and `runtime.json`. Setup installed the protected controller in the private demo repository after preflight passed.

## Compatible native boundary observed

The official published [Codex 0.125.0 release](https://github.com/openai/codex/releases/tag/rust-v0.125.0) includes the deprecated `features.use_legacy_landlock=true` option. Its [Linux implementation](https://github.com/openai/codex/blob/rust-v0.125.0/codex-rs/linux-sandbox/src/landlock.rs) applies Landlock and `PR_SET_NO_NEW_PRIVS`; it does not require creating user namespaces. This is a deliberately pinned compatibility choice, not a claim of current upstream support or hardened isolation.

That older backend does not itself enforce the newer metadata carveouts. The trusted supervisor therefore owns `.git`, `.codex`, `.agents`, and `AGENTS.md`, removes their write bits while preserving bytes and executable modes, and keeps `/workspace` root-owned with sticky mode `1777`. Source files remain editable by the agent. These are separate, explicitly recorded native filesystem and OS metadata protections.

An actual hosted disposable branch proved successful source edits and creation, denied writes to an otherwise agent-writable file outside the workspace, denied root credential and process-environment reads, denied privilege escalation, and denied metadata write/chmod/unlink/rename/symlink replacement and directory removal. All assertions passed, metadata hashes remained intact, effective capabilities were zero, and `NoNewPrivs` was set. Native `config/read` and `skills/list` also succeeded. The test made no model calls, and branch deletion was confirmed.

Private reproducible evidence: `.fullbeam-state/evidence/diagnostics/compat-codex125-fullauto-1789765227600.json` and `compat-codex125-full-auto-probe.mjs` in the same directory. Two earlier diagnostic attempts are retained: the first lost buffered output on exit, and the second exposed the diagnostic command's read-only default. The [debug command loader](https://github.com/openai/codex/blob/rust-v0.125.0/codex-rs/cli/src/debug_sandbox.rs#L590-L625) requires `sandbox linux --full-auto` to test workspace writes. Generation separately uses `exec --sandbox workspace-write` with approval policy `never`.

The rebuilt runtime subsequently passed its own complete preflight, including a model-issued terminal command and a nonce-bound output file. Native configuration validation remains explicit: the frozen five-key TOML allowlist and native project-layer/effective-setting equality are required. This client has no `--strict-config` option; evidence reports that honestly.

## What passed

- GitHub authentication with `repo` and `workflow`, private repository creation, branch protection, and encrypted Actions secret installation.
- OpenAI access and actual native Codex benchmark execution: the completed Luna comparison retained baseline 6/6 passes and candidate 5/6 passes, with one functional failure rather than an omitted attempt.
- Authenticated InstaCloud MCP discovery of 64 tools using the durable agent credential.
- Remote image builds and HTTPS health checks for separate generation and verifier template projects.
- Fresh branch creation, explicit compute startup, and readiness checks.
- Native Codex 0.153.2 project configuration and skill discovery inside the hosted generation environment.
- Synthetic credential isolation checks: the unprivileged agent cannot read the root-only probe file or root supervisor environment.
- Deletion of all disposable diagnostic branches and the two obsolete template projects.

## Original 0.153.2 blocking observation

The required native `workspace-write` sandbox fails for the unprivileged agent (UID 10001):

```text
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.
```

The observed guest kernel was Linux 6.18.35. The diagnostic root process reported no seccomp filter, and `user.max_user_namespaces` was positive. These observations do not establish that an unprivileged process can create the required namespaces: the actual native probe failed.

Installing Debian's standard `bubblewrap` 0.8.0 package on a disposable branch did not resolve the failure. The supported `features.use_legacy_landlock=true` switch also failed:

```text
permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock
```

The pinned client rejects legacy projection of the required permission profile. Its native metadata protections also prevent treating a narrower working directory as an equivalent fallback. See the [permission projection rules](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/protocol/src/permissions.rs#L1739-L1757), [metadata protection tests](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/protocol/src/permissions.rs#L3781-L3865), and [legacy rejection](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/linux-sandbox/src/linux_run_main.rs#L377-L390). The documented [Bubblewrap prerequisite](https://learn.chatgpt.com/docs/sandboxing#prerequisites) was tested against the real hosted environment.

No compatible setting was found in the current InstaCloud CLI or documented compute controls. The implementation retains `workspace-write`, `approval_policy=never`, separate OS identities, and mandatory sandbox preflight. It does not replace these with unrestricted execution.

## Original image state and resumption

Running Codex 0.153.2 with Bubblewrap still requires a provider configuration that permits its namespaces. Adding another credential to `.env` does not address that failure. The demonstrated 0.125.0 compatibility path now has its own immutable runtime identity and passed preflight.

The obsolete 0.153.2 template identities were:

| Role         | Project                                | Image digest                                                              |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| Generation   | `543ce9af-d7e4-488e-a504-91715de9cd54` | `sha256:ea9221f744b82935bd95d4201a173157f784cc78a3d235f03b0f9e884953b8ba` |
| Verification | `3c33cb5d-df11-485e-88ba-72fb84f52cc1` | `sha256:1ec55db550d6e4e3c843127982563ed29065fec8ac0d00a19eed97afc846e5de` |

Private evidence of the original failure is retained in `.fullbeam-state/evidence/diagnostics/` and `.fullbeam-state/evidence/runtime-revisions/`. The new READY runtime subsequently completed all 18 calibration controls, the real cancellation/recovery exercise, and strict acceptance of the Luna comparison. These are separate observations linked in [acceptance evidence](acceptance.md); the original failure was not rewritten.

Both obsolete projects were deleted after verifying their exact archived identity, failed preflight, paused state, and absence from the new READY lock. Their absence was confirmed. Deletion receipts and failure evidence are retained under `.fullbeam-state/evidence/runtime-revisions/2026-09-18T21-06-38.546Z-3ef5de0b-6d86-4d44-9366-224d73d80c17/`. The original user project and new READY projects were untouched. The adapter explicitly starts each new attempt branch and waits for readiness; operators need no additional hand-edited runtime configuration.

After a runtime source change, use the documented `npm run setup -- --refresh-runtime` flow, followed by `npm run demo`. Setup requires mandatory preflight before installing the protected controller. Successful account login, image deployment, the diagnostic above, or local tests must not be reported as a completed benchmark.
