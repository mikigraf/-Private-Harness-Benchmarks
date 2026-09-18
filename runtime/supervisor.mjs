/** Trusted image entrypoint. Never copy this file from a candidate checkout. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  rename,
  stat,
  lstat,
  readdir,
  chmod,
  chown,
  open,
  rm,
  access,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
const { parse: parseToml } = createRequire(import.meta.url)("@iarna/toml");
const ROOT = "/var/lib/fullbeam",
  WORK = "/workspace",
  AGENT = 10001,
  VERIFIER = 10002,
  APP = 10003;
export const NATIVE_VERSION = "0.125.0";
const SELF = fileURLToPath(import.meta.url),
  MAX_FILE = 1048576,
  MAX_TOTAL = 8388608,
  MAX_LOG = 4194304;
const sha = (x) => createHash("sha256").update(x).digest("hex");
const json = (x) => JSON.stringify(x);
const now = () => new Date().toISOString();
const safeId = (id) => {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid execution/upload ID");
  return id;
};
const pathAllowed = (p, allowed) =>
  allowed.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x));
export function detectViolations(before, after, allowed, protectedPaths = []) {
  const old = new Map(before.map((f) => [f.path, f])),
    current = new Map(after.map((f) => [f.path, f]));
  const violations = [];
  for (const path of new Set([...old.keys(), ...current.keys()])) {
    const a = old.get(path),
      b = current.get(path);
    if (a?.sha256 === b?.sha256 && a?.mode === b?.mode) continue;
    if (!pathAllowed(path, allowed) || pathAllowed(path, protectedPaths))
      violations.push(path);
  }
  return violations.sort();
}
export async function snapshot(root) {
  const files = [],
    violations = [],
    excludedPaths = [];
  let total = 0;
  async function walk(dir, prefix = "") {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const path = prefix + name,
        absolute = join(dir, name);
      const info = await lstat(absolute);
      // Original Git objects are absent. This fresh local Git store and immutable deps are runtime infrastructure.
      if (!prefix && [".git", "node_modules", "dist"].includes(name)) {
        if (!info.isDirectory()) violations.push(path);
        else excludedPaths.push(path + "/");
        continue;
      }
      if (
        name === "node_modules" ||
        name === ".git" ||
        path.length > 240 ||
        /[\x00-\x1f\x7f\\]/.test(path)
      ) {
        violations.push(path + ":unsafe-path");
        continue;
      }
      if (
        info.isSymbolicLink() ||
        (!info.isFile() && !info.isDirectory()) ||
        (info.nlink > 1 && info.isFile())
      ) {
        violations.push(path);
        continue;
      }
      if (info.isDirectory()) {
        await walk(absolute, path + "/");
        continue;
      }
      total += info.size;
      if (info.size > MAX_FILE || total > MAX_TOTAL || files.length >= 2048) {
        violations.push(path + ":output-limit");
        continue;
      }
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      files.push({
        path,
        content: bytes.toString("base64"),
        size: bytes.length,
        sha256: sha(bytes),
        mode: info.mode & 0o111 ? 0o100755 : 0o100644,
      });
    }
  }
  await walk(root);
  return { files, violations, excludedPaths };
}
export function validateProxyRequest(
  method,
  path,
  authorization,
  body,
  policy,
) {
  const actual = Buffer.from(authorization ?? ""),
    expected = Buffer.from("Bearer " + policy.token);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    Date.now() >= policy.expiresAt
  )
    throw new Error("Model access expired or unauthorized");
  if (
    method !== "POST" ||
    path !== "/v1/responses" ||
    !body ||
    body.model !== policy.model
  )
    throw new Error("Model proxy endpoint/model denied");
  const allowedTool = (t, depth = 0) =>
    t &&
    depth < 4 &&
    (["function", "custom"].includes(t.type) ||
      (t.type === "tool_search" && t.execution === "client") ||
      (t.type === "namespace" &&
        Array.isArray(t.tools) &&
        t.tools.every((n) => allowedTool(n, depth + 1))));
  if (
    body.background ||
    body.previous_response_id ||
    (body.tools !== undefined &&
      (!Array.isArray(body.tools) || body.tools.some((t) => !allowedTool(t))))
  )
    throw new Error("Model proxy tool or background access denied");
  return true;
}
function cleanEnv(uid, extra = {}) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: `/home/${uid === AGENT ? "agent" : uid === APP ? "application" : "verifier"}`,
    LANG: "C.UTF-8",
    NODE_ENV: "test",
    ...extra,
  };
}
async function ownedDir(path, uid, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
  await chown(path, uid, uid);
}
async function atomic(path, value) {
  const temp = path + ".tmp";
  await writeFile(temp, json(value), { mode: 0o600 });
  await rename(temp, path);
}
async function runAs(
  argv,
  uid,
  {
    cwd = WORK,
    env = {},
    timeout = 30000,
    input = "",
    logLimit = MAX_LOG,
  } = {},
) {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((x) => typeof x !== "string" || x.includes("\0"))
  )
    throw new Error("Invalid trusted argv");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      uid,
      gid: uid,
      env: cleanEnv(uid, env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      truncated = false,
      timedOut = false,
      settled = false;
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) + chunk.length > logLimit) {
        truncated = true;
        return current;
      }
      return current + chunk.toString();
    };
    child.stdout.on("data", (x) => {
      stdout = append(stdout, x);
    });
    child.stderr.on("data", (x) => {
      stderr = append(stderr, x);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      killUid(uid);
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      if (!settled) {
        settled = true;
        resolve({ code, signal, stdout, stderr, truncated, timedOut });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
function killUid(uid) {
  try {
    execFileSync("/usr/bin/pkill", ["-KILL", "-u", String(uid)], {
      stdio: "ignore",
      env: cleanEnv(0),
    });
  } catch {}
}
async function modelProxy(key, model, timeoutSeconds) {
  const token = randomBytes(32).toString("hex"),
    policy = { token, model, expiresAt: Date.now() + timeoutSeconds * 1000 };
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      if (++calls > 500)
        throw new Error("Attempt model request limit exceeded");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      validateProxyRequest(
        req.method,
        req.url,
        req.headers.authorization,
        body,
        policy,
      );
      body.store = false;
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: json(body),
        signal: AbortSignal.timeout(Math.max(1, policy.expiresAt - Date.now())),
      });
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent)
        res.writeHead(403, { "Content-Type": "application/json" });
      res.end(json({ error: { message: "Attempt model access denied" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    token,
    port: server.address().port,
    close: () => {
      policy.expiresAt = 0;
      server.closeAllConnections();
      server.close();
    },
  };
}
async function prepareHome(uid) {
  const home = cleanEnv(uid).HOME;
  await ownedDir(home, uid);
  await ownedDir(join(home, ".codex"), uid);
  if (uid === AGENT) {
    await writeFile(
      join(home, ".gitconfig"),
      "[safe]\n\tdirectory = /workspace\n",
      { mode: 0o644 },
    );
    await chown(join(home, ".gitconfig"), uid, uid);
    const config = '[projects."/workspace"]\ntrust_level = "trusted"\n';
    await writeFile(join(home, ".codex/config.toml"), config, { mode: 0o600 });
    await chown(join(home, ".codex/config.toml"), uid, uid);
  }
  return home;
}
async function initializeGit(uid) {
  const env = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: WORK,
  };
  const manifest = JSON.parse(
    await readFile(join(ROOT, "bundle.json"), "utf8"),
  );
  const declared = manifest.files.map((f) => f.path);
  for (const argv of [
    ["git", "init", "--quiet"],
    ["git", "add", "--force", "--", ...declared],
    [
      "git",
      "-c",
      "user.name=Fullbeam",
      "-c",
      "user.email=fullbeam@invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Frozen historical source",
    ],
  ]) {
    const result = await runAs(argv, uid, { env });
    if (result.code !== 0)
      throw new Error("Fresh source repository initialization failed");
  }
}
export function validateNativeConfig(text, input) {
  const settings = parseToml(text);
  const supported = new Set([
    "model",
    "model_reasoning_effort",
    "approval_policy",
    "sandbox_mode",
    "web_search",
  ]);
  for (const key of Object.keys(settings))
    if (!supported.has(key))
      throw new Error(
        "CANDIDATE_CONFIG_ERROR: unsupported native setting " + key,
      );
  if (settings.model !== input.model)
    throw new Error(
      "CANDIDATE_CONFIG_ERROR: input model differs from frozen native config",
    );
  if (settings.model_reasoning_effort !== input.reasoningEffort)
    throw new Error(
      "CANDIDATE_CONFIG_ERROR: input reasoning differs from frozen native config",
    );
  if (
    settings.approval_policy !== "never" ||
    settings.sandbox_mode !== "workspace-write" ||
    settings.web_search !== "disabled"
  )
    throw new Error("CANDIDATE_CONFIG_ERROR: unsupported native permissions");
  return settings;
}
// Called before any candidate process starts. Landlock bounds workspace writes;
// Unix ownership additionally protects native metadata inside that workspace.
export async function sealNativeMetadata(
  root = WORK,
  { uid = 0, gid = 0 } = {},
) {
  const workspace = await lstat(root);
  if (
    !workspace.isDirectory() ||
    workspace.isSymbolicLink() ||
    workspace.uid !== uid ||
    workspace.gid !== gid ||
    (workspace.mode & 0o7777) !== 0o1777
  )
    throw new Error(
      "Native metadata requires workspace ownership and sticky mode 1777",
    );
  const entries = [];
  async function inspect(path, directory = false) {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (directory && !info.isDirectory()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new Error("Unsafe native metadata: " + path);
    entries.push({ path, info });
    if (info.isDirectory())
      for (const name of await readdir(path)) await inspect(join(path, name));
  }
  for (const path of [".git", ".codex", ".agents"]) {
    try {
      await mkdir(join(root, path), { mode: 0o755 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await inspect(join(root, path), true);
  }
  const instructionFiles = [];
  for (const path of ["AGENTS.md", "skills.md"]) {
    try {
      await inspect(join(root, path));
      instructionFiles.push(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // Validate the whole tree before altering permissions. File descriptors prevent
  // a replacement link from redirecting ownership or chmod to another target.
  for (const { path, info } of entries) {
    const handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (info.isDirectory() ? constants.O_DIRECTORY : 0),
    );
    try {
      const actual = await handle.stat();
      if (actual.dev !== info.dev || actual.ino !== info.ino)
        throw new Error(
          "Unsafe native metadata changed during sealing: " + path,
        );
      await handle.chown(uid, gid);
      await handle.chmod(info.mode & 0o555);
    } finally {
      await handle.close();
    }
  }
  return {
    version: "unix-metadata-v1",
    installed: true,
    roots: [".git", ".codex", ".agents", ...instructionFiles],
    ownerUid: uid,
    ownerGid: gid,
    workspaceMode: "1777",
    entries: entries.length,
  };
}
export function nativeSandboxArgs(command) {
  return [
    "-c",
    "features.use_legacy_landlock=true",
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="never"',
    "sandbox",
    "linux",
    "--full-auto",
    "--",
    ...command,
  ];
}
function nativeOverrides(input, port) {
  const settings = {
    model: input.model,
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    "features.use_legacy_landlock": true,
    web_search: "disabled",
    model_provider: "fullbeam",
    "model_providers.fullbeam.name": "Fullbeam scoped OpenAI proxy",
    "model_providers.fullbeam.base_url": `http://127.0.0.1:${port}/v1`,
    "model_providers.fullbeam.env_key": "OPENAI_API_KEY",
    "model_providers.fullbeam.wire_api": "responses",
    "model_providers.fullbeam.requires_openai_auth": false,
  };
  if (input.reasoningEffort)
    settings.model_reasoning_effort = input.reasoningEffort;
  return Object.entries(settings).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
}
// Inspect the same pinned native loader and session overrides used by codex exec.
// No thread/turn is started and the inspection child receives no model credential.
export async function inspectNativeSettings(
  input,
  {
    cwd = WORK,
    home = "/home/agent",
    uid = AGENT,
    port,
    codexPath = "codex",
    expectedSkills = [],
  } = {},
) {
  cwd = await realpath(cwd);
  home = await realpath(home);
  const child = spawn(
    codexPath,
    ["app-server", "--listen", "stdio://", ...nativeOverrides(input, port)],
    {
      cwd,
      uid,
      gid: uid === process.getuid?.() ? process.getgid?.() : uid,
      env: cleanEnv(uid, { HOME: home, CODEX_HOME: join(home, ".codex") }),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = new Promise((r) => child.once("close", r));
  let timer;
  let observed;
  try {
    observed = await new Promise((resolve, reject) => {
      let pending = "",
        bytes = 0,
        configuration;
      const send = (message) => child.stdin.write(json(message) + "\n");
      const fail = (reason) =>
        reject(new Error("NATIVE_CONFIG_UNVERIFIED: " + reason));
      timer = setTimeout(() => fail("native inspection timed out"), 15000);
      child.on("error", () => fail("native inspection could not start"));
      child.on("close", () =>
        fail("native inspection ended before returning evidence"),
      );
      child.stdin.on("error", () => fail("native inspection transport closed"));
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_LOG) fail("native inspection exceeded output limit");
      });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_LOG)
          return fail("native inspection exceeded output limit");
        pending += chunk.toString();
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return fail("native inspection returned malformed JSON");
          }
          if (message.error) return fail("native configuration RPC failed");
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({
              id: 2,
              method: "config/read",
              params: { cwd, includeLayers: true },
            });
          } else if (message.id === 2) {
            configuration = message.result;
            send({
              id: 3,
              method: "skills/list",
              params: { cwds: [cwd], forceReload: true },
            });
          } else if (message.id === 3) {
            resolve({ configuration, skills: message.result });
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "fullbeam_native_inspection", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await closed;
  }
  const { config, layers } = observed.configuration ?? {};
  const project = layers?.find(
    (layer) =>
      layer.name?.type === "project" &&
      layer.name.dotCodexFolder === join(cwd, ".codex"),
  );
  if (!input.capabilityProbe) {
    if (!project || project.disabledReason)
      throw new Error(
        "NATIVE_CONFIG_UNVERIFIED: native project configuration is not enabled",
      );
    const frozen = parseToml(
      await readFile(join(cwd, ".codex/config.toml"), "utf8"),
    );
    if (
      Object.keys(frozen).some(
        (key) => json(project.config?.[key]) !== json(frozen[key]),
      )
    )
      throw new Error(
        "NATIVE_CONFIG_UNVERIFIED: native project configuration differs from frozen files",
      );
  }
  const provider = config?.model_providers?.fullbeam;
  if (
    !config ||
    config.model !== input.model ||
    (input.reasoningEffort &&
      config.model_reasoning_effort !== input.reasoningEffort) ||
    config.approval_policy !== "never" ||
    config.sandbox_mode !== "workspace-write" ||
    config.features?.use_legacy_landlock !== true ||
    config.web_search !== "disabled" ||
    config.model_provider !== "fullbeam" ||
    provider?.base_url !== `http://127.0.0.1:${port}/v1` ||
    provider.wire_api !== "responses" ||
    provider.env_key !== "OPENAI_API_KEY" ||
    provider.requires_openai_auth !== false
  )
    throw new Error(
      "NATIVE_CONFIG_UNVERIFIED: native effective settings differ from attempt policy",
    );
  const discovery = observed.skills?.data?.find((entry) => entry.cwd === cwd);
  if (
    !discovery ||
    !Array.isArray(discovery.skills) ||
    discovery.errors?.length
  )
    throw new Error("CANDIDATE_CONFIG_ERROR: native skill discovery failed");
  const nativeSkills = discovery.skills.map(
    ({ name, path, scope, enabled }) => ({ name, path, scope, enabled }),
  );
  for (const path of expectedSkills) {
    const absolute = await realpath(join(cwd, path));
    if (
      !nativeSkills.some(
        (skill) => skill.path === absolute && skill.enabled === true,
      )
    )
      throw new Error(
        "CANDIDATE_CONFIG_ERROR: native skill was not exposed: " + path,
      );
  }
  return {
    status: "VERIFIED",
    source: "codex app-server config/read and skills/list",
    model: config.model,
    reasoningEffort: config.model_reasoning_effort,
    approvalPolicy: config.approval_policy,
    sandboxMode: config.sandbox_mode,
    webSearch: config.web_search,
    modelProvider: config.model_provider,
    providerWireApi: provider.wire_api,
    providerEndpointScope: "loopback attempt proxy",
    projectConfig: {
      path: join(cwd, ".codex/config.toml"),
      enabled: !!project && !project.disabledReason,
      version: project?.version ?? null,
    },
    // Layer identities and native discovery are evidence; credentials/config payloads are not retained.
    layers: layers.map(({ name, version, disabledReason }) => ({
      name,
      version,
      disabledReason: disabledReason ?? null,
    })),
    nativeSkills,
    strictConfig: false,
    configValidation: "explicit frozen-key allowlist and native layer equality",
    sandboxImplementation:
      "native legacy Landlock with supervisor metadata guard",
    legacyLandlock: config.features.use_legacy_landlock,
    ephemeral: true,
    isolatedHome: home,
    projectTrust: cwd,
  };
}
async function runGeneration(input, result) {
  if (
    typeof input.prompt !== "string" ||
    !input.prompt ||
    typeof input.model !== "string" ||
    !input.modelApiKey
  )
    throw new Error("Generation requires prompt, model and scoped credential");
  if (!input.capabilityProbe) {
    const nativeConfig = await readFile(
      join(WORK, ".codex/config.toml"),
      "utf8",
    );
    validateNativeConfig(nativeConfig, input);
    result.nativeConfigSha256 = sha(nativeConfig);
  }
  const installed = await snapshot(WORK);
  result.nativeComponents = installed.files
    .filter(
      (f) =>
        f.path === "AGENTS.md" ||
        f.path.endsWith("/AGENTS.md") ||
        f.path.startsWith(".agents/skills/"),
    )
    .map((f) => ({
      path: f.path,
      sha256: f.sha256,
      materialized: "YES",
      exposed: "UNKNOWN",
      observedUse: "UNKNOWN",
    }));
  await prepareHome(AGENT);
  await initializeGit(AGENT);
  result.metadataGuard = await sealNativeMetadata();
  const native = await runAs(["codex", "--version"], AGENT);
  result.nativeVersion = native.stdout.trim();
  if (
    result.nativeVersion !==
    `codex-cli ${input.nativeVersion ?? NATIVE_VERSION}`
  )
    throw new Error("Native Codex version mismatch");
  const proxy = await modelProxy(
    input.modelApiKey,
    input.model,
    input.timeoutSeconds,
  );
  result.effectiveNativeSettings = { status: "UNKNOWN" };
  try {
    result.effectiveNativeSettings = {
      ...(await inspectNativeSettings(input, {
        port: proxy.port,
        expectedSkills: installed.files
          .filter((f) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(f.path))
          .map((f) => f.path),
      })),
      nativeVersion: result.nativeVersion,
    };
    const args = [
      "codex",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "-C",
      WORK,
      ...nativeOverrides(input, proxy.port),
    ];
    args.push("-");
    const agentStart = performance.now();
    let output;
    try {
      output = await runAs(args, AGENT, {
        env: { OPENAI_API_KEY: proxy.token, CODEX_HOME: "/home/agent/.codex" },
        input: input.prompt,
        timeout: input.timeoutSeconds * 1000,
        logLimit: Math.min(input.maxOutputBytes ?? MAX_LOG, MAX_LOG),
      });
    } finally {
      result.agentDurationMs = Math.round(performance.now() - agentStart);
    }
    result.events = output.stdout;
    result.stderr = output.stderr;
    result.exitCode = output.code;
    result.logsTruncated = output.truncated;
    result.status = output.timedOut
      ? "AGENT_TIMEOUT"
      : output.code === 0
        ? "COMPLETED"
        : "AGENT_ERROR";
    result.usage = output.stdout.split("\n").flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.usage ? [event.usage] : [];
      } catch {
        return [];
      }
    });
  } finally {
    proxy.close();
    killUid(AGENT);
  }
}
export function verificationFailureKind(applicationExitCode, timedOut) {
  return applicationExitCode !== null
    ? "APPLICATION_EXIT"
    : timedOut
      ? "VERIFICATION_TIMEOUT"
      : undefined;
}
async function runVerification(input, result) {
  if (
    !input.verifierModuleBase64 ||
    sha(Buffer.from(input.verifierModuleBase64, "base64")) !==
      input.verifierSha256
  )
    throw new Error("Trusted verifier digest mismatch");
  await prepareHome(APP);
  await prepareHome(VERIFIER);
  const privateDir = join(ROOT, "verifier");
  await mkdir(privateDir, { mode: 0o750 });
  await chown(privateDir, 0, VERIFIER);
  const modulePath = join(privateDir, "verifier.mjs");
  await writeFile(
    modulePath,
    Buffer.from(input.verifierModuleBase64, "base64"),
    { mode: 0o440 },
  );
  await chown(modulePath, 0, VERIFIER);
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  const build = await runAs(
    input.buildCommand ?? ["npm", "run", "build"],
    APP,
    { timeout: Math.max(1, deadline - Date.now()) },
  );
  result.events = build.stdout;
  result.stderr = build.stderr;
  result.buildPassed = build.code === 0;
  result.exitCode = build.code;
  result.logsTruncated = build.truncated;
  killUid(APP);
  if (!result.buildPassed) {
    result.status = "FUNCTIONAL_FAIL";
    return;
  }
  const port = input.port ?? 3100;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid verifier port");
  const argv = input.startCommand ?? ["npm", "start"];
  const server = spawn(argv[0], argv.slice(1), {
    uid: APP,
    gid: APP,
    cwd: WORK,
    env: cleanEnv(APP, {
      PORT: String(port),
      HOST: "127.0.0.1",
      RELAYDESK_FIXED_TIME: "2025-01-01T00:00:00.000Z",
      RELAYDESK_ID_PREFIX: "fixture",
    }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError;
  server.on("error", (e) => {
    serverError = e;
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      if (result.stderr.length + chunk.length < MAX_LOG)
        result.stderr += chunk.toString();
      else result.logsTruncated = true;
    });
  try {
    const startupDeadline = Math.min(deadline, Date.now() + 20000);
    result.startupPassed = false;
    while (
      Date.now() < startupDeadline &&
      !serverError &&
      server.exitCode === null
    ) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.status === 200) {
          result.startupPassed = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!result.startupPassed) {
      result.status = "FUNCTIONAL_FAIL";
      return;
    }
    const output = await runAs(["node", modulePath], VERIFIER, {
      cwd: privateDir,
      env: {
        TARGET_URL: `http://127.0.0.1:${port}`,
        FULLBEAM_TASK_ID: input.taskId ?? "",
      },
      timeout: Math.max(1, deadline - Date.now()),
    });
    result.exitCode = output.code;
    result.stderr += output.stderr;
    result.logsTruncated ||= output.truncated;
    if (output.code !== 0) {
      result.failureKind = verificationFailureKind(
        server.exitCode,
        output.timedOut,
      );
      result.status = result.failureKind ? "FUNCTIONAL_FAIL" : "INFRA_ERROR";
      result.error =
        server.exitCode !== null
          ? "Application exited during independent checks"
          : output.timedOut
            ? "Application verification exceeded its time budget"
            : "Trusted verifier failed to produce authoritative results";
      return;
    }
    const report = JSON.parse(output.stdout);
    if (
      !Array.isArray(report.checks) ||
      report.checks.length === 0 ||
      report.checks.some(
        (c) => !c.id || !["PASS", "FAIL", "SKIP"].includes(c.status),
      ) ||
      new Set(report.checks.map((c) => c.id)).size !== report.checks.length
    )
      throw new Error("Malformed or zero-check verifier report");
    result.checks = report.checks;
    result.status = report.checks.every((c) => c.status === "PASS")
      ? "COMPLETED"
      : "FUNCTIONAL_FAIL";
  } finally {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
    killUid(APP);
    killUid(VERIFIER);
  }
}
export async function captureResult(result, before, input, root = WORK) {
  const after = await snapshot(root);
  result.files = after.files;
  result.excludedPaths = after.excludedPaths;
  result.afterManifest = after.files.map(({ content, ...f }) => f);
  result.beforeManifest = before
    ? before.files.map(({ content, ...f }) => f)
    : [];
  result.violations.push(...(before?.violations ?? []), ...after.violations);
  if (before) {
    const allowed =
      input.role === "generation" ? (input.allowedWritePaths ?? ["src/"]) : [];
    result.violations.push(
      ...detectViolations(
        before.files,
        after.files,
        allowed,
        input.protectedPaths ?? [],
      ),
    );
  }
  result.violations = [...new Set(result.violations)].sort();
  if (result.violations.length) result.status = "POLICY_VIOLATION";
  // Integrity records authoritative root capture, independently of execution success.
  result.integrityVerified = true;
}
async function worker(id, probe = false) {
  const execution = join(ROOT, "executions", safeId(id)),
    input = JSON.parse(await readFile(join(execution, "input.json"), "utf8"));
  const startedAt = now();
  const result = {
    executionId: id,
    role: input.role,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    agentDurationMs: null,
    status: "INFRA_ERROR",
    exitCode: null,
    checks: [],
    files: [],
    beforeManifest: [],
    afterManifest: [],
    violations: [],
    events: "",
    stderr: "",
    logsTruncated: false,
    usage: [],
    excludedPaths: [],
    integrityVerified: false,
  };
  let before;
  try {
    if (!probe) {
      const uid = input.role === "generation" ? AGENT : APP;
      await prepareHome(uid);
      await assignWorkspace(uid);
    }
    before = await snapshot(WORK);
    if (probe) {
      await new Promise((r) => setTimeout(r, 1500));
      result.status = "COMPLETED";
      result.exitCode = 0;
    } else if (input.role === "generation") await runGeneration(input, result);
    else if (input.role === "verification")
      await runVerification(input, result);
    else throw new Error("Invalid role");
  } catch (error) {
    result.error = String(error);
    result.status = result.error.includes("CANDIDATE_CONFIG_ERROR:")
      ? "CANDIDATE_CONFIG_ERROR"
      : "INFRA_ERROR";
  } finally {
    killUid(AGENT);
    killUid(APP);
    killUid(VERIFIER);
    try {
      await captureResult(result, before, input);
    } catch (error) {
      result.error =
        (result.error ? result.error + "; " : "") +
        "Output capture failed: " +
        String(error);
      result.integrityVerified = false;
      result.status = "INFRA_ERROR";
    }
    result.endedAt = now();
    result.durationMs = Date.parse(result.endedAt) - Date.parse(startedAt);
    await atomic(join(execution, "result.json"), result);
    await atomic(join(execution, "status.json"), {
      executionId: id,
      state: result.status === "INFRA_ERROR" ? "FAILED" : "COMPLETED",
      startedAt,
      endedAt: result.endedAt,
      ...(result.error ? { error: result.error } : {}),
    });
  }
}
async function materialize(id) {
  const data = await readFile(join(ROOT, "uploads", safeId(id) + ".data"));
  if (sha(data) !== id) throw new Error("Bundle digest mismatch");
  const bundle = JSON.parse(data);
  if (!Array.isArray(bundle.files) || bundle.files.length > 2048)
    throw new Error("Bundle count limit");
  const existing = await readdir(WORK);
  if (existing.length) throw new Error("Attempt workspace is not empty");
  const paths = new Set();
  let total = 0;
  for (const f of bundle.files) {
    if (
      typeof f.path !== "string" ||
      f.path.startsWith("/") ||
      /^[A-Za-z]:/.test(f.path) ||
      f.path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(f.path) ||
      f.path
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            p === ".git" ||
            p === "node_modules",
        ) ||
      paths.has(f.path)
    )
      throw new Error("Unsafe or duplicate bundle path");
    paths.add(f.path);
    const bytes = Buffer.from(f.content, "base64");
    total += bytes.length;
    if (
      ![0o100644, 0o100755].includes(f.mode) ||
      bytes.toString("base64") !== f.content ||
      bytes.length !== f.size ||
      sha(bytes) !== f.sha256 ||
      bytes.length > MAX_FILE ||
      total > MAX_TOTAL
    )
      throw new Error("Invalid bundle record");
  }
  for (const f of bundle.files) {
    const path = join(WORK, f.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, Buffer.from(f.content, "base64"), {
      flag: "wx",
      mode: f.mode & 0o777,
    });
  }
  await atomic(join(ROOT, "bundle.json"), {
    digest: id,
    files: bundle.files.map(({ content, ...f }) => f),
  });
  return { digest: id };
}
async function assignWorkspace(uid) {
  // Ownership assignment happens before starting any untrusted process.
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Unexpected workspace symlink");
    await chown(path, uid, uid);
    if (info.isDirectory())
      for (const n of await readdir(path)) await visit(join(path, n));
  }
  await visit(WORK);
  await chown(WORK, 0, 0);
  await chmod(WORK, 0o1777);
  // Dependency installation stays remote, with ignored lifecycle scripts, using the frozen lockfile.
  const lock = join(WORK, "package-lock.json");
  let installed = false;
  try {
    await access(lock);
    const install = await runAs(
      ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      uid,
      { timeout: 120000 },
    );
    if (install.code !== 0)
      throw new Error(
        "Frozen dependency installation failed: " +
          install.stderr.slice(0, 2000),
      );
    installed = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Make dependencies root-owned, read-only to the agent. They cannot conceal a persistent payload.
  const modules = join(WORK, "node_modules");
  if (installed) {
    execFileSync("chown", ["-R", "0:0", modules]);
    execFileSync("chmod", ["-R", "a-w", modules]);
  }
}
async function launch(input, id, probe = false) {
  if ((await readdir(join(ROOT, "executions"))).length)
    throw new Error("An environment can execute only once");
  const dir = join(ROOT, "executions", id);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "input.json"), json(input), { mode: 0o600 });
  const state = { executionId: id, state: "RUNNING", startedAt: now() };
  await atomic(join(dir, "status.json"), state);
  const child = spawn("node", [SELF, probe ? "probe-worker" : "worker", id], {
    detached: true,
    stdio: "ignore",
    env: cleanEnv(0),
  });
  child.unref();
  return state;
}
async function probe(role) {
  if (
    (await readdir(WORK)).length ||
    (await readdir(join(ROOT, "executions"))).length ||
    (await readdir(join(ROOT, "uploads"))).length
  )
    throw new Error("Template contains task state");
  const forbidden = Object.keys(process.env).filter((k) =>
    /GITHUB|INSTACLOUD|INSTA_API|OPENAI_API|TOKEN|SECRET/i.test(k),
  );
  if (forbidden.length)
    throw new Error("Template exposes unexpected environment credentials");
  await prepareHome(AGENT);
  await chown(WORK, 0, 0);
  await chmod(WORK, 0o1777);
  const secret = join(ROOT, "probe-secret");
  const outside = "/home/agent/sandbox-boundary";
  await writeFile(secret, "root-only-probe", { mode: 0o600 });
  const isolation = await runAs(
    [
      "node",
      "-e",
      `const fs=require('fs');for(const p of [${JSON.stringify(secret)},'/proc/${process.pid}/environ']){try{fs.readFileSync(p);process.exit(20)}catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(21)}}`,
    ],
    AGENT,
  );
  const native = await runAs(["codex", "--version"], AGENT);
  let nativeConfiguration = { status: "UNKNOWN" };
  let sandbox = { code: null, stderr: "Sandbox probe did not complete" };
  let receipt;
  let metadataGuard;
  let metadataIntact = false;
  let outsideControlPassed = false;
  const protectedFiles = [
    ".git/config",
    ".codex/config.toml",
    ".agents/skills/fullbeam-probe/SKILL.md",
    "AGENTS.md",
    "skills.md",
  ];
  const protectedRoots = [".git", ".codex", ".agents"];
  const expectedChecks = [
    "source-edit",
    "source-create",
    "outside-workspace-write",
    "root-credential-read",
    "root-process-environ-read",
    "root-identity-escalation",
    "no-new-privileges",
    "no-effective-capabilities",
    ...protectedFiles.flatMap((p) =>
      ["append", "chmod", "unlink", "rename", "symlink-replace"].map(
        (op) => p + ":" + op,
      ),
    ),
    ...protectedRoots.flatMap((p) =>
      ["chmod", "root-rename", "new-symlink", "recursive-remove"].map(
        (op) => p + ":" + op,
      ),
    ),
  ];
  try {
    await ownedDir(join(WORK, "src"), AGENT, 0o755);
    await writeFile(join(WORK, "src/probe.txt"), "source positive control");
    await chown(join(WORK, "src/probe.txt"), AGENT, AGENT);
    const git = await runAs(["git", "init", "--quiet"], AGENT);
    if (git.code !== 0) throw new Error("Native probe Git setup failed");
    await ownedDir(join(WORK, ".codex"), AGENT, 0o755);
    await ownedDir(join(WORK, ".agents/skills/fullbeam-probe"), AGENT, 0o755);
    await writeFile(
      join(WORK, ".codex/config.toml"),
      'model="fullbeam-native-probe"\nmodel_reasoning_effort="high"\napproval_policy="never"\nsandbox_mode="workspace-write"\nweb_search="disabled"\n',
      { mode: 0o644 },
    );
    await writeFile(
      join(WORK, ".agents/skills/fullbeam-probe/SKILL.md"),
      "---\nname: fullbeam-probe\ndescription: Verify native skill discovery without a model request.\n---\nRead the probe contract.\n",
      { mode: 0o644 },
    );
    await writeFile(join(WORK, "AGENTS.md"), "Native probe instructions.\n");
    await writeFile(
      join(WORK, "skills.md"),
      "Native probe human skill index.\n",
    );
    metadataGuard = await sealNativeMetadata();
    const before = await Promise.all(
      protectedFiles.map(async (p) => sha(await readFile(join(WORK, p)))),
    );
    try {
      nativeConfiguration = await inspectNativeSettings(
        { model: "fullbeam-native-probe", reasoningEffort: "high" },
        { port: 9, expectedSkills: [".agents/skills/fullbeam-probe/SKILL.md"] },
      );
    } catch (error) {
      nativeConfiguration = { status: "UNKNOWN", error: String(error) };
    }
    // Positive control: the same UID can write this path without native sandboxing.
    const control = await runAs(
      [
        "node",
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(outside)},'agent-owned')`,
      ],
      AGENT,
    );
    outsideControlPassed = control.code === 0;
    const program = `
      const fs=require('node:fs'), checks={};
      function deny(id,fn){try{fn();checks[id]={passed:false,error:'unexpectedly allowed'}}catch(e){checks[id]={passed:['EACCES','EPERM','EROFS'].includes(e.code),code:e.code}}}
      function allow(id,fn){try{fn();checks[id]={passed:true}}catch(e){checks[id]={passed:false,code:e.code}}}
      allow('source-edit',()=>fs.appendFileSync('/workspace/src/probe.txt',' edited'));
      allow('source-create',()=>fs.writeFileSync('/workspace/src/new.txt','created'));
      deny('outside-workspace-write',()=>fs.appendFileSync(${JSON.stringify(outside)},'bad'));
      deny('root-credential-read',()=>fs.readFileSync(${JSON.stringify(secret)}));
      deny('root-process-environ-read',()=>fs.readFileSync('/proc/${process.pid}/environ'));
      deny('root-identity-escalation',()=>process.setuid(0));
      for(const rel of ${JSON.stringify(protectedFiles)}){
        const p='/workspace/'+rel;
        deny(rel+':append',()=>fs.appendFileSync(p,'bad'));
        deny(rel+':chmod',()=>fs.chmodSync(p,0o777));
        deny(rel+':unlink',()=>fs.unlinkSync(p));
        deny(rel+':rename',()=>fs.renameSync(p,p+'.moved'));
        const staged='/workspace/probe-replacement';
        fs.symlinkSync('/workspace/src/probe.txt',staged);
        deny(rel+':symlink-replace',()=>fs.renameSync(staged,p));
        fs.unlinkSync(staged);
      }
      for(const rel of ${JSON.stringify(protectedRoots)}){
        const p='/workspace/'+rel;
        deny(rel+':chmod',()=>fs.chmodSync(p,0o777));
        deny(rel+':root-rename',()=>fs.renameSync(p,p+'.moved'));
        deny(rel+':new-symlink',()=>fs.symlinkSync('/workspace/src/probe.txt',p+'/probe-link'));
        deny(rel+':recursive-remove',()=>fs.rmSync(p,{recursive:true}));
      }
      const status=fs.readFileSync('/proc/self/status','utf8');
      const noNewPrivileges=/^NoNewPrivs:\\s+1$/m.test(status);
      const capEff=/^CapEff:\\s+(\\w+)$/m.exec(status)?.[1];
      checks['no-new-privileges']={passed:noNewPrivileges};
      checks['no-effective-capabilities']={passed:/^0+$/.test(capEff??'')};
      const report={uid:process.getuid(),gid:process.getgid(),noNewPrivileges,capEff,checks};
      fs.writeFileSync('/workspace/src/sandbox-receipt.json',JSON.stringify(report));
      process.exitCode=Object.values(checks).every(x=>x.passed)?0:20;
    `;
    sandbox = await runAs(
      ["codex", ...nativeSandboxArgs(["node", "-e", program])],
      AGENT,
    );
    // Some provider/CLI combinations suppress nested stdout. A trusted-generated
    // receipt read by root gives complete assertion evidence independently of it.
    try {
      receipt = JSON.parse(
        await readFile(join(WORK, "src/sandbox-receipt.json"), "utf8"),
      );
    } catch {}
    const after = await Promise.all(
      protectedFiles.map(async (p) => sha(await readFile(join(WORK, p)))),
    );
    metadataIntact = before.every((hash, i) => hash === after[i]);
  } catch (error) {
    sandbox.stderr += "\n" + String(error);
  } finally {
    for (const name of await readdir(WORK))
      await rm(join(WORK, name), { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(secret, { force: true });
  }
  const passed =
    sandbox.code === 0 &&
    outsideControlPassed &&
    metadataIntact &&
    receipt?.uid === AGENT &&
    receipt?.gid === AGENT &&
    Object.keys(receipt?.checks ?? {}).length === expectedChecks.length &&
    expectedChecks.every((id) => receipt?.checks?.[id]?.passed === true);
  return {
    role,
    cleanTemplate: true,
    credentialIsolation: isolation.code === 0,
    nativeSandbox: passed,
    nativeNoNewPrivileges: passed && receipt.noNewPrivileges === true,
    metadataGuardVerified: passed && metadataIntact,
    nativeSandboxImplementation: "legacy-landlock-with-unix-metadata-v1",
    nativeSandboxEvidence: {
      outsideControlPassed,
      metadataIntact,
      metadataGuard,
      receipt: receipt ?? null,
    },
    nativeConfigVerified: nativeConfiguration.status === "VERIFIED",
    nativeConfiguration,
    nativeVersion: native.stdout.trim(),
    sandboxError: passed
      ? ""
      : sandbox.stderr.slice(0, 2000) ||
        "Native sandbox assertion failed or receipt missing",
    uids: { agent: AGENT, verifier: VERIFIER, application: APP },
    egressRestrictions: "UNKNOWN",
  };
}
export async function initializeSupervisorState(
  root = ROOT,
  { uid = 0, gid = 0 } = {},
  workspace = WORK,
) {
  // Every supervisor RPC (including status while a worker runs) repeats this.
  // Retain existing state, but never follow links or adopt an untrusted owner.
  for (const [path, mode] of [
    [root, 0o711],
    [join(root, "uploads"), 0o700],
    [join(root, "executions"), 0o700],
  ]) {
    let handle;
    try {
      try {
        await mkdir(path, { mode });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isDirectory() || info.uid !== uid || info.gid !== gid)
        throw new Error("Unexpected directory owner or type");
      await handle.chmod(mode);
    } catch {
      throw new Error("Unsafe supervisor state directory: " + path);
    } finally {
      await handle?.close();
    }
  }
  try {
    await mkdir(workspace, { mode: 0o755 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // The worker deliberately changes workspace ownership and its sticky bit.
  // Poll/collect must preserve that state instead of revoking ongoing writes.
  let workspaceHandle;
  try {
    workspaceHandle = await open(
      workspace,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error("Unsafe supervisor workspace directory: " + workspace);
  } finally {
    await workspaceHandle?.close();
  }
}
async function main() {
  if (process.getuid?.() !== 0)
    throw new Error("Supervisor requires trusted root context");
  await initializeSupervisorState();
  const [verb, ...args] = process.argv.slice(2);
  let out;
  if (verb === "worker" || verb === "probe-worker") {
    await worker(args[0], verb === "probe-worker");
    return;
  }
  if (verb === "upload-begin") {
    const [id, size, kind] = args;
    safeId(id);
    if (
      !["bundle", "input"].includes(kind) ||
      !Number.isInteger(+size) ||
      +size < 1 ||
      +size > 16777216
    )
      throw new Error("Upload limit");
    const path = join(ROOT, "uploads", id);
    await writeFile(path + ".data", "", { flag: "wx", mode: 0o600 });
    await atomic(path + ".meta", { size: +size, kind });
    out = { ok: true };
  } else if (verb === "upload-chunk") {
    const [id, offset, content] = args,
      path = join(ROOT, "uploads", safeId(id) + ".data"),
      info = await stat(path);
    const bytes = Buffer.from(content, "base64"),
      meta = JSON.parse(
        await readFile(join(ROOT, "uploads", id + ".meta"), "utf8"),
      );
    if (
      +offset !== info.size ||
      bytes.length > 24576 ||
      info.size + bytes.length > meta.size ||
      bytes.toString("base64") !== content
    )
      throw new Error("Upload chunk mismatch");
    const f = await open(path, "a");
    try {
      await f.write(bytes);
    } finally {
      await f.close();
    }
    out = { offset: info.size + bytes.length };
  } else if (verb === "upload-finish") {
    const id = safeId(args[0]),
      path = join(ROOT, "uploads", id),
      data = await readFile(path + ".data"),
      meta = JSON.parse(await readFile(path + ".meta", "utf8"));
    if (data.length !== meta.size || sha(data) !== id)
      throw new Error("Upload integrity failed");
    out = { sha256: id };
  } else if (verb === "materialize") out = await materialize(args[0]);
  else if (verb === "start") {
    const id = safeId(args[0]),
      input = JSON.parse(
        await readFile(join(ROOT, "uploads", id + ".data"), "utf8"),
      );
    if (
      !["generation", "verification"].includes(input.role) ||
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > 3600
    )
      throw new Error("Invalid input");
    out = await launch(input, id);
  } else if (verb === "start-probe") {
    const id = sha(randomBytes(32));
    out = await launch(
      { role: "generation", timeoutSeconds: 5, allowedWritePaths: [] },
      id,
      true,
    );
  } else if (verb === "status") {
    const id = safeId(args[0]);
    out = JSON.parse(
      await readFile(join(ROOT, "executions", id, "status.json"), "utf8"),
    );
  } else if (verb === "collect") {
    const bytes = await readFile(
      join(ROOT, "executions", safeId(args[0]), "result.json"),
    );
    out = { size: bytes.length, sha256: sha(bytes) };
  } else if (verb === "read-artifact") {
    const [id, offset, length] = args;
    if (
      !Number.isInteger(+offset) ||
      +offset < 0 ||
      !Number.isInteger(+length) ||
      +length < 1 ||
      +length > 24576
    )
      throw new Error("Artifact read bounds");
    const bytes = await readFile(
      join(ROOT, "executions", safeId(id), "result.json"),
    );
    out = {
      content: bytes.subarray(+offset, +offset + +length).toString("base64"),
    };
  } else if (verb === "probe") out = await probe(args[0]);
  else if (verb === "serve") {
    createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"service":"fullbeam-runtime","ready":true}');
    }).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
    return;
  } else throw new Error("Unknown supervisor verb");
  process.stdout.write(json(out) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === SELF)
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exitCode = 1;
  });
