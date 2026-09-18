# Review an agent's code on GitHub

Open an evaluation in the dashboard, select **Changes**, and expand a task attempt. Its captured source diff, observed native model/settings, verification results, and cleanup result are shown together. Choose **Create draft review PR** to publish that particular patch to the connected private repository. The button becomes a GitHub link, and the receipt is retained in InstaCloud Postgres.

Live example: [review PR #11](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/11) contains Luna's first tenant-idempotency attempt from [evaluation 35399118845](https://github.com/mikigraf/fullbeam-relaydesk-demo/actions/runs/35399118845), using [configuration PR #9](https://github.com/mikigraf/fullbeam-relaydesk-demo/pull/9). Its four-file patch built successfully but failed `idempotency.object-order-equivalent`. The draft retains that failure. The GitHub patch bytes were checked against the captured output; the configuration and default-branch commits remained unchanged. Repeating the request returned the same PR.

Each attempt uses a snapshot branch containing the exact source and harness that the agent received. A separate commit contains its captured output. The draft PR compares those two snapshots, so GitHub's Files changed view shows the actual attempt patch. Its description links the evaluation, configuration PR, task, model, and outcome. Failed and policy-rejected attempts can be useful to review too; a review PR is not evidence that a task passed.

The configuration PR stays at its evaluated commit. Appending generated application code to it would change the submitted configuration and mix different historical task starting points. Individual review PRs keep those identities intact and distinguish repeated attempts. They are not automatically merged into the snapshot branch, the configuration branch, or `main`.

Publishing is explicit for each attempt. Repeating the same request reuses its recorded PR instead of creating duplicates. The draft targets its dedicated snapshot base, so merging it would not promote the change to the application's main branch. A closed PR remains available from the app.

Only integrity-verified captured inputs and outputs are eligible. The server selects those files from retained evidence; the browser cannot supply replacement code. Workflow/controller metadata and credential files are rejected before publication. A narrow compatibility exception preserves unchanged inert controller-template `AGENTS.md` files that were included in older harness captures; future harness exports exclude them. If exact captured source is unavailable, the app reports that limitation instead of synthesizing a patch.

All configuration remains in the root `.env`; the existing GitHub credential creates the draft and the existing InstaCloud database stores its receipt. See [the dashboard guide](dashboard.md) and [harness configuration](harness-experiments.md).
