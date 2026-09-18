# InstaCloud connection

The workspace is linked to the existing `private-benchmarks` project using the [official setup guide](https://instacloud.com/prompt.md) and the installed InstaCloud agent skill.

| Setting                   | Verified value                         |
| ------------------------- | -------------------------------------- |
| Environment               | `prod`                                 |
| API                       | `https://api.instacloud.com`           |
| Project                   | `8306db8f-9f91-49f4-9d49-db561845e6f0` |
| Organization              | `54f8f46c-ffa3-46fe-9bbc-4ae840afa537` |
| Linked branch             | `main`                                 |
| Global CLI installed      | `0.1.0`                                |
| Initial service inventory | Empty; no deployment URL yet           |

The project binding is stored in `.insta/project.json`. The installer registered the remote MCP server and installed the agent skill and credential-audit hooks. Codex's separate MCP OAuth login completed on 2026-09-18. Newly registered tools require a fresh coding-agent session; CLI login and MCP login are separate credentials.

A fresh Codex process discovered `insta_whoami` and `insta_project_get`, but the client blocked both before execution: `MCP tool call requires approval, but approval policy is never.` OAuth storage is confirmed; successful authenticated MCP calls are not. CLI access remains available. No approval policy was changed to bypass the client block.

The authenticated project agent session lasts 24 hours. Refresh it from this workspace with:

```sh
insta --agent agent setup -y
insta --agent status
insta --agent agent manifest --json
```

Agent commands use `--agent` and remain subject to the project's current policy. Session credentials, local control-plane state, and generated audit files are gitignored. The tracked hooks contain no credentials.

## Fullbeam configuration

The verified `INSTA_ORG_ID` and `FULLBEAM_INSTACLOUD_REGION=us-east` were filled into the existing root `.env`. The GitHub credential, owned demo repository name, and direct OpenAI model settings were also filled. The private [mikigraf/fullbeam-relaydesk-demo](https://github.com/mikigraf/fullbeam-relaydesk-demo) repository was created (ID `1376394100`) and its `main` branch protection was verified. GitHub's `repo` and `workflow` scopes are now authorized and the refreshed credential is saved in `.env`.

Local CLI or MCP browser login does not replace `FULLBEAM_INSTACLOUD_API_TOKEN`: unattended GitHub Actions needs a durable credential. InstaCloud's supported `insta --agent login --claim <email>` flow issued the `agent:codex` credential after the account owner's confirmation on 2026-09-18. It is saved in the ignored root `.env` with owner-only file permissions. All required settings are now present, and `npm run doctor` verified GitHub authentication and access to the configured OpenAI model. Direct token minting from a signed agent is restricted; do not extract browser session credentials or remove agent governance to work around it.

The chosen runtime is native Codex on InstaCloud using `OPENAI_API_KEY`. HarnessRouter is not used. An existing `HR_API_KEY` in the local file is ignored by the product and is not copied to Actions or runtime environments. Other settings are documented in [configuration.md](configuration.md).

Available regions observed through `insta --agent config regions --json` were `us-east`, `eu-central`, and `ap-southeast`. Change the selected region in `.env` if another is preferred.

Fullbeam's controller runs locally and in GitHub Actions. Its generation and verifier require two separate empty, immutable runtime template projects, provisioned by `npm run setup` after the required configuration is present. This linked project was not adopted as either template.

The dashboard now uses real InstaCloud Postgres in the original project `8306db8f-9f91-49f4-9d49-db561845e6f0`, branch `main`: service `fullbeam-db` (`dce750ec-e0f3-48c9-b902-1b77f1f65a22`). An authenticated query against Postgres 16.15 succeeded, and the client connection used authorized TLS. Its `DATABASE_URL` and project ID are stored only in the ignored root `.env`. Database credentials are kept out of generation and verification environments. Application migrations live in `migrations/`.

The global CLI installation and Fullbeam's pinned dependency both use `insta@0.1.0`. The controller uses explicit agent mode and isolated per-project CLI directories. Authenticated MCP discovery returned 64 tool schemas, and two source-bound runtime images were deployed successfully. Their Codex 0.153.2 namespace sandbox failed. A later disposable hosted test passed all 47 boundary checks using official Codex 0.125.0, native Landlock, and explicit root-owned metadata guards. The updated immutable images subsequently passed complete hosted preflight, including an actual OpenAI-backed Codex tool call and confirmed cleanup. The protected GitHub controller is installed and the real benchmark demo is in progress. See the [runtime compatibility record](instacloud-runtime-blocker.md) for exact evidence and resumption instructions.
