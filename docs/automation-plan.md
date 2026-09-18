# Automated InstaCloud benchmark execution

The selected architecture is native Codex on hosted InstaCloud VMs, using the operator's OpenAI API key. GitHub Actions coordinates each comparison. An independent, model-free InstaCloud VM grades submitted source. InstaCloud Postgres stores the dashboard queue and retained report/task/configuration/patch projections; private GitHub Actions artifacts hold the original execution bundles. All service credentials use the same root `.env`.

1. Update the pinned InstaCloud adapter to the current supported CLI, with explicit agent identity and project isolation. Verify deployment, image identity, file transfer, execution, cancellation, and deletion against real services.
2. Configure the single root `.env` using existing account access and a user-confirmed durable InstaCloud agent credential. Keep secrets out of command output, source, candidate files, and verifier environments.
3. Make `npm run demo` prepare resources and complete the owned three-task demonstration without prompts. Record automated review honestly as `AUTOMATED_DEMO` with calibrated SILVER tasks, while retaining explicit human-reviewed GOLD mode.
4. Run the real GitHub issue/PR, calibration, repeated generation, independent grading, publication, and cleanup path. Preserve failures and exact runtime/source identities. Report blockers rather than claiming success from unit tests.

The only unavoidable account interactions are the providers' one-time authentication/permission confirmations. Subsequent runs use the stored credentials and recorded benchmark state.

Work ownership: the cloud adapter and automated demo are separate implementation tasks. Configuration, CLI integration, comparison/report policy, documentation, and live validation are coordinated by the root task. Shared interfaces are `Config.demoMode`, `demo(..., {automated})`, and a qualification-mode guard shared by the demo and comparison.
