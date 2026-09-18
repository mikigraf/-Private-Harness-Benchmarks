import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const runtime = () => import("../runtime/supervisor.mjs" as string);
const input = { model: "fixture-model", reasoningEffort: "high" };

async function fixture(change?: (response: any) => void) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fullbeam-native-rpc-")),
  );
  const cwd = join(root, "work"),
    home = join(root, "home");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  const frozen = {
    model: input.model,
    model_reasoning_effort: "high",
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    web_search: "disabled",
  };
  await writeFile(
    join(cwd, ".codex/config.toml"),
    Object.entries(frozen)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n"),
  );
  const response = {
    config: {
      ...frozen,
      features: { use_legacy_landlock: true },
      model_provider: "fullbeam",
      model_providers: {
        fullbeam: {
          base_url: "http://127.0.0.1:9/v1",
          wire_api: "responses",
          env_key: "OPENAI_API_KEY",
          requires_openai_auth: false,
        },
      },
    },
    layers: [
      {
        name: { type: "project", dotCodexFolder: join(cwd, ".codex") },
        config: { ...frozen },
        version: "native-test-layer",
      },
    ],
  };
  change?.(response);
  const codexPath = join(root, "codex-protocol-fixture");
  // This subprocess implements the published 0.125 app-server wire contract;
  // it rejects the newer CLI flags that previously made that version unusable.
  await writeFile(
    codexPath,
    `#!${process.execPath}
const readline=require('node:readline');
const args=process.argv.slice(2);
if(args[0]!=='app-server'||args[1]!=='--listen'||args[2]!=='stdio://' || args.includes('--strict-config') || args.includes('--stdio') || !args.includes('features.use_legacy_landlock=true') || process.env.OPENAI_API_KEY) process.exit(42);
const configuration=${JSON.stringify(response)};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line); if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={};
  else if(request.method==='config/read'){
    if(request.params.cwd!==${JSON.stringify(cwd)} || request.params.includeLayers!==true)process.exit(43);
    result=configuration;
  } else if(request.method==='skills/list')result={data:[{cwd:${JSON.stringify(cwd)},skills:[],errors:[]}]};
  else process.exit(44);
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
    { mode: 0o755 },
  );
  return { root, cwd, home, codexPath, uid: process.getuid?.(), port: 9 };
}

it("uses the 0.125 native protocol and reports the actual validation policy", async () => {
  const f = await fixture();
  try {
    const { inspectNativeSettings } = await runtime();
    const evidence = await inspectNativeSettings(input, f);
    expect(evidence.status).toBe("VERIFIED");
    expect(evidence.strictConfig).toBe(false);
    expect(evidence.legacyLandlock).toBe(true);
    expect(evidence.projectConfig.enabled).toBe(true);
    expect(evidence.configValidation).toMatch(
      /allowlist.*native layer equality/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each([false, undefined])(
  "rejects native Landlock evidence %s despite matching model and permissions",
  async (observed) => {
    const f = await fixture((r) => {
      r.config.features.use_legacy_landlock = observed;
    });
    try {
      const { inspectNativeSettings } = await runtime();
      await expect(inspectNativeSettings(input, f)).rejects.toThrow(
        /native effective settings differ/i,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it("rejects frozen project disagreement even when session overrides produce the expected model", async () => {
  const f = await fixture((r) => {
    r.layers[0].config.model = "different-candidate-model";
  });
  try {
    const { inspectNativeSettings } = await runtime();
    await expect(inspectNativeSettings(input, f)).rejects.toThrow(
      /project configuration differs from frozen files/i,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("selects the debug command's writable sandbox instead of its implicit read-only default", async () => {
  const { nativeSandboxArgs } = await runtime();
  const argv = nativeSandboxArgs(["node", "-e", "trusted probe"]);
  expect(argv.slice(argv.indexOf("sandbox"))).toEqual([
    "sandbox",
    "linux",
    "--full-auto",
    "--",
    "node",
    "-e",
    "trusted probe",
  ]);
  expect(argv).toContain("features.use_legacy_landlock=true");
  expect(argv).toContain('approval_policy="never"');
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});
