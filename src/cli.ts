#!/usr/bin/env node
import { Command } from "commander";
import { readFile, mkdir, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadConfig,
  readEnvironment,
  missingSettings,
  redact,
  secretsOf,
  type Config,
} from "./core/config.js";
import { EvidenceStore } from "./core/store.js";
import { canonical, digest } from "./core/integrity.js";
import { setupProduct } from "./product/setup.js";
import { checkBootstrapAccounts } from "./product/account-preflight.js";
import { demo, qualificationOnly } from "./product/demo.js";
import { github, defaultHead, readRepoJson } from "./product/github-context.js";
import { dispatchAndWait, readArtifactJson } from "./product/actions.js";
import { controller, publish } from "./product/controller.js";
import { recover, sweep, type RecoveryConfig } from "./product/recovery.js";
import { GitHubActions, GitHubIntake } from "./github/index.js";
import { renderReport, validateReportIdentity } from "./product/report.js";
import { RemoteController } from "./product/remote.js";
import { createHarnessProposal } from "./product/harness.js";
import { exportHarness } from "./product/harness-export.js";
import { setupDatabase } from "./product/database-setup.js";
import type {
  PublishedReport,
  DemoState,
  RuntimeLock,
} from "./product/types.js";
import type { JournalEvent } from "./core/checkpoints.js";

const program = new Command()
  .name("fullbeam")
  .description(
    "GitHub-native harness comparisons with independent Instacloud verification",
  )
  .version("0.1.0");
const integer = (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Expected a positive integer");
  return n;
};
function recoveryConfig(): RecoveryConfig {
  const env = readEnvironment();
  const map = {
    githubToken: env.GITHUB_TOKEN || env.FULLBEAM_GITHUB_TOKEN,
    repository:
      env.GITHUB_REPOSITORY ||
      env.FULLBEAM_REPOSITORY ||
      env.FULLBEAM_DEMO_REPOSITORY,
    instacloudToken: env.FULLBEAM_INSTACLOUD_API_TOKEN,
    orgId: env.INSTA_ORG_ID,
    region: env.FULLBEAM_INSTACLOUD_REGION,
  };
  for (const [key, value] of Object.entries(map))
    if (!value) throw new Error(`Missing recovery setting: ${key}`);
  return { ...map, stateDir: resolve(".fullbeam-state") } as RecoveryConfig;
}
program
  .command("doctor")
  .option(
    "--offline",
    "Only inspect local configuration; do not call external services",
  )
  .action(async (options) => {
    const env = readEnvironment();
    console.log(`Node ${process.version}; required Node 24.x`);
    if (Number(process.versions.node.split(".")[0]) !== 24)
      throw new Error("Install Node 24.x");
    const missing = missingSettings(env);
    console.log(`Configuration file: ${resolve(".env")}`);
    if (missing.length) {
      console.log(`Not configured: ${missing.join(", ")}`);
      console.log(
        "Local source is available. Live GitHub/Instacloud/model execution is NOT verified.",
      );
      process.exitCode = 2;
      return;
    }
    const config = loadConfig(env);
    console.log(
      `Repository: ${config.repository}; model: ${config.model}; region: ${config.region}`,
    );
    if (!options.offline) {
      const account = await checkBootstrapAccounts(config);
      console.log(`GitHub authenticated actor: ${account.actor}`);
      console.log(
        "Configured OpenAI model is accessible. Instacloud lifecycle and isolation checks run during setup.",
      );
      if (config.databaseUrl) {
        await setupDatabase(config);
        console.log(
          "InstaCloud Postgres connection verified; credentials remain in .env.",
        );
      } else {
        console.log(
          "Dashboard Postgres will be provisioned by setup or dashboard startup.",
        );
      }
    }
    const store = new EvidenceStore(join(config.stateDir, "evidence"));
    const preflight =
      await store.state<RuntimeLock["capability"]>("preflight.json");
    if (preflight?.status === "BLOCKED") {
      console.log(
        `Last recorded runtime preflight: BLOCKED (${preflight.checkedAt})`,
      );
      for (const blocker of preflight.blockers)
        console.log(redact(blocker, secretsOf(config)));
      for (const role of ["generation", "verification"]) {
        const observation = preflight.observations[role] as
          { nativeSandbox?: boolean; sandboxError?: string } | undefined;
        if (observation?.nativeSandbox === false && observation.sandboxError)
          console.log(
            redact(
              `${role}: ${observation.sandboxError.trim()}`,
              secretsOf(config),
            ),
          );
      }
      console.log(
        "Configuration is present; live execution is blocked. See docs/instacloud-runtime-blocker.md and retry setup after resolving the capability failure.",
      );
      process.exitCode = 2;
      return;
    }
    console.log(
      preflight?.status === "READY"
        ? `Configuration validated. Recorded hosted preflight: READY (${preflight.checkedAt}). Run npm run demo to validate setup and execute the repository benchmark.`
        : "Configuration validated. Run npm run setup for mandatory live preflight.",
    );
  });
program
  .command("setup")
  .option(
    "--refresh-runtime",
    "Archive stale local template allocation state and provision a new source-bound runtime revision",
  )
  .action(async (options) => {
    const config = await setupDatabase(loadConfig());
    const result = await setupProduct(config, {
      refreshRuntime: options.refreshRuntime,
    });
    console.log(
      `Setup complete: https://github.com/${result.state.repository}\nRuntime preflight: ${result.runtime.capability.status}\nRun npm run demo to create and review real seed history.`,
    );
  });
program
  .command("demo")
  .option("--automated", "Run the owned fixture without human review prompts")
  .option("--reviewed", "Require human review of seed fixes and qualification")
  .option(
    "--previous <comparison-id>",
    "Link the new demo comparison to an earlier immutable comparison",
  )
  .option(
    "--approve-seed <sha>",
    "Approve a previously reviewed exact seed head",
  )
  .option(
    "--approve-qualification <digest>",
    "Approve a previously reviewed calibration payload",
  )
  .option(
    "--replay <run-id>",
    "Display a saved real report, explicitly as a replay",
    integer,
  )
  .action(async (options) => {
    let config = loadConfig();
    if (options.automated && options.reviewed)
      throw new Error("Choose either --automated or --reviewed");
    if (options.replay) {
      console.log(
        "REPLAY — previously recorded evidence, not a live execution.",
      );
      await showReport(
        { ...config, repository: config.demoRepository },
        options.replay,
      );
      return;
    }
    const automated = options.reviewed
      ? false
      : options.automated || config.demoMode === "automated";
    console.log("Preparing the owned demo repository and InstaCloud runtimes…");
    config = await setupDatabase(config);
    await setupProduct(config);
    await demo(
      { ...config, repository: config.demoRepository },
      { ...options, automated },
    );
  });
const harness = program
  .command("harness")
  .description("Edit versioned native Codex models, instructions, and skills");
harness
  .command("export")
  .requiredOption(
    "--out <directory>",
    "New directory for editable native harness files",
  )
  .option("--ref <ref>", "Repository commit or ref; defaults to protected main")
  .action(async (options) => {
    const result = await exportHarness(loadConfig(), options.out, {
      ref: options.ref,
    });
    console.log(
      `Exported ${result.files.length} harness files at ${result.head}\n${result.directory}\nEdit .codex/config.toml, AGENTS.md, skills.md, or .agents/skills/, then use harness propose --overlay ${JSON.stringify(result.directory)}.`,
    );
  });
harness
  .command("propose")
  .requiredOption("--name <name>", "Stable name for this harness proposal")
  .option(
    "--model <model>",
    "Candidate Codex model; overrides the overlay config",
  )
  .option(
    "--reasoning-effort <effort>",
    "Candidate effort; overrides the overlay config",
  )
  .option("--overlay <directory>", "Directory of edited native harness files")
  .action(async (options) => {
    const result = await createHarnessProposal(loadConfig(), {
      name: options.name,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      overlayDir: options.overlay,
    });
    console.log(
      `${result.classification}: ${result.url}\nFrozen candidate head: ${result.head}\nChanged files: ${result.changedPaths.join(", ")}\nEvaluate with: npm run compare -- --pr ${result.pr}`,
    );
  });
program
  .command("compare")
  .requiredOption("--pr <number>", "Harness-only candidate PR", integer)
  .option(
    "--previous <id>",
    "Link a new comparison to an earlier immutable comparison",
  )
  .action(async (options) => {
    const config = loadConfig();
    const run = await dispatchAndWait(
      github(config),
      "compare",
      options.pr,
      options.previous,
    );
    console.log(`${run.url}\nExecution: ${run.conclusion}`);
    if (run.conclusion !== "success") process.exitCode = 1;
  });
program
  .command("qualify")
  .option(
    "--approve <digest>",
    "Approve an already reviewed exact qualification payload",
  )
  .action(async (options) => {
    await qualificationOnly(loadConfig(), {
      approveQualification: options.approve,
    });
  });
program
  .command("import")
  .requiredOption("--task <id>", "Owned seeded task ID")
  .requiredOption("--issue <number>", "Real issue number", integer)
  .requiredOption("--pr <number>", "Associated squash-merged PR", integer)
  .action(async (options) => {
    const config = loadConfig();
    const head = await defaultHead(github(config));
    const client = github(config, config.repository, head.id);
    const state = await readRepoJson<DemoState>(
      client,
      ".fullbeam/demo-state.json",
      head.sha,
    );
    const seed = state.items.find(
      (t) =>
        t.id === options.task &&
        t.issue === options.issue &&
        t.pr === options.pr,
    );
    if (!seed?.merge_receipt)
      throw new Error(
        "UNSUPPORTED_HISTORY: P0 import requires an owned recorded squash merge and original prompt snapshot; arbitrary repository qualification is outside this release",
      );
    const pair = await new GitHubIntake(client).snapshotPair({
      issueNumber: options.issue,
      pullNumber: options.pr,
      seedMergeReceipt: seed.merge_receipt,
    });
    const store = new EvidenceStore(join(config.stateDir, "evidence"));
    const ref = await store.putJson(pair);
    console.log(
      `Imported real provenance: ${ref.sha256}\nRun fullbeam qualify to calibrate; import alone never earns GOLD.`,
    );
  });
program
  .command("report")
  .requiredOption("--run-id <number>", "Real GitHub Actions run", integer)
  .action(async (options) => {
    await showReport(loadConfig(), options.runId);
  });
program.command("cleanup").action(async () => {
  const config = loadConfig();
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  let runtime = await store.state<RuntimeLock>("runtime.json");
  if (!runtime) {
    const client = github(config);
    const head = await defaultHead(client);
    runtime = await readRepoJson(
      client,
      ".fullbeam/runtime.lock.json",
      head.sha,
    );
  }
  let paths: string[] = [];
  try {
    paths = await readdir(join(store.root, "journals"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const name of paths.filter((p) => p.endsWith(".json"))) {
    const remote = new RemoteController(
      config,
      runtime!,
      store,
      name.slice(0, -5),
    );
    await remote.initialize();
    try {
      if (!(await remote.cleanup())) process.exitCode = 1;
    } finally {
      await remote.close();
    }
  }
  console.log(
    "Recorded local attempts reconciled. Immutable template projects are retained; use recover/sweep for Actions resources.",
  );
});
program
  .command("recover")
  .requiredOption(
    "--run-id <number>",
    "Actions run owning the resources",
    integer,
  )
  .action(async (options) => {
    const result = await recover(recoveryConfig(), options.runId);
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  });
program.command("sweep").action(async () => sweep(recoveryConfig()));
program.command("verify-live").action(async () => {
  const config = loadConfig();
  const client = github(config, config.demoRepository);
  const head = await defaultHead(client);
  const state = await readRepoJson<DemoState>(
    client,
    ".fullbeam/demo-state.json",
    head.sha,
  );
  if (!state.qualified || !state.candidate_pr)
    throw new Error(
      "Complete npm run demo before live acceptance; reviewed mode additionally requires its explicit reviews",
    );
  const run = await dispatchAndWait(client, "compare", state.candidate_pr);
  const report = await showReport(
    { ...config, repository: config.demoRepository },
    run.id,
  );
  if (
    report.summary.execution_completeness !== "COMPLETE" ||
    report.summary.distinct_tasks !== 3 ||
    report.runs.length !== 12 ||
    report.cleanup_status !== "CONFIRMED"
  )
    throw new Error(
      "Live acceptance incomplete; inspect retained observations",
    );
  console.log(
    "Observed live acceptance: three qualified tasks, 12 attempts, commit-bound report and confirmed cleanup. Model failures remain visible.",
  );
});
program
  .command("controller", { hidden: true })
  .requiredOption("--operation <operation>")
  .requiredOption("--trigger <id>")
  .option("--pr <number>", "Candidate", integer)
  .option("--previous <id>")
  .action(async (options) => {
    if (!["compare", "qualify"].includes(options.operation))
      throw new Error("Unsupported controller operation");
    await controller(loadConfig(), options);
  });
program
  .command("publish", { hidden: true })
  .requiredOption("--file <path>")
  .action(async (options) => publish(options.file));
async function showReport(
  config: Config,
  runId: number,
): Promise<PublishedReport> {
  const client = github(config);
  const repo = await defaultHead(client);
  const store = new EvidenceStore(join(config.stateDir, "evidence"));
  const cache = `saved-reports/${repo.id}/${runId}.json`;
  let report = await store.state<PublishedReport>(cache);
  if (!report) {
    const archive = await new GitHubActions(client).downloadRunArtifact(
      runId,
      `fullbeam-evidence-${runId}`,
    );
    report = readArtifactJson<PublishedReport>(archive.zip, "report.json");
    validateReportIdentity(report, runId, repo.id);
    await store.immutable(cache, report);
  }
  validateReportIdentity(report, runId, repo.id);
  const pull = await client.rest<{ head: { sha: string } }>(
    "GET",
    `pulls/${report.comparison.candidate_pr}`,
  );
  console.log(renderReport(report, pull.head.sha));
  return report;
}
try {
  await program.parseAsync();
} catch (error) {
  const env = readEnvironment();
  console.error(
    redact(error instanceof Error ? error.message : String(error), [
      env.FULLBEAM_GITHUB_TOKEN ?? "",
      env.GITHUB_TOKEN ?? "",
      env.FULLBEAM_INSTACLOUD_API_TOKEN ?? "",
      env.OPENAI_API_KEY ?? "",
    ]),
  );
  process.exitCode = process.exitCode || 1;
}
