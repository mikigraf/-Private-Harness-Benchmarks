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

The project binding is stored in `.insta/project.json`. The installer registered the remote MCP server and installed the agent skill and credential-audit hooks. Restart the coding tool to load newly registered MCP tools; a client may still need its own OAuth authorization.

The authenticated project agent session lasts 24 hours. Refresh it from this workspace with:

```sh
insta --agent agent setup -y
insta --agent status
insta --agent agent manifest --json
```

Agent commands use `--agent` and remain subject to the project's current policy. Session credentials, local control-plane state, and generated audit files are gitignored. The tracked hooks contain no credentials.

## Fullbeam configuration

The verified `INSTA_ORG_ID` was filled into the existing root `.env`. Local browser login does not replace `FULLBEAM_INSTACLOUD_API_TOKEN`: unattended GitHub Actions still needs the operator's durable API token. The remaining account and model settings are documented in [configuration.md](configuration.md).

Available regions observed through `insta --agent config regions --json` were `us-east`, `eu-central`, and `ap-southeast`. Choose the intended region in `.env` when configuring the benchmark.

Fullbeam's controller runs locally and in GitHub Actions. Its generation and verifier require two separate empty, immutable runtime template projects, provisioned by `npm run setup` after the required configuration is present. This linked project was not silently adopted as either template, and no database, compute service, or deployment was created during connection setup.

The global CLI installation is separate from Fullbeam's pinned `insta@0.0.83` dependency. Its authenticated runtime preflight and the actual benchmark demo have not been run; linking the workspace does not establish live benchmark readiness.
