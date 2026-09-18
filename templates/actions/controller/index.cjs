const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

// GitHub supplies artifact runtime credentials to JavaScript actions, not shell
// run steps. Keep them in this process and its trusted child; never export or log
// them. This action is included in the checked-out protected controller payload.
async function main() {
  for (const name of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL"])
    if (!process.env[name])
      throw new Error(`GitHub artifact runtime is unavailable: ${name}`);
  const operation = process.env.FULLBEAM_OPERATION;
  const trigger = process.env.FULLBEAM_TRIGGER_ID ?? "";
  const candidate = process.env.FULLBEAM_CANDIDATE_PR ?? "";
  const previous = process.env.FULLBEAM_PREVIOUS_ID ?? "";
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(trigger))
    throw new Error("Invalid trigger identity");
  const args = ["controller", "--operation", operation, "--trigger", trigger];
  if (operation === "compare") {
    if (!/^[1-9][0-9]*$/.test(candidate))
      throw new Error("candidate_pr must be a positive integer for compare");
    args.push("--pr", candidate);
    if (previous) args.push("--previous", previous);
  } else if (operation === "qualify") {
    if (candidate || previous)
      throw new Error(
        "candidate_pr and previous_id are valid only for compare",
      );
  } else throw new Error("Unsupported controller operation");

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: resolve(__dirname, "../../.."),
      env: process.env,
      stdio: "inherit",
      shell: false,
    },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Trusted controller could not start")),
      );
      child.once("close", (code, signal) =>
        resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
