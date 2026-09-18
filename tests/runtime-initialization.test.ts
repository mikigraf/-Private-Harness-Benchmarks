import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const supervisorUrl = pathToFileURL(resolve("runtime/supervisor.mjs")).href;
const owner = { uid: process.getuid?.(), gid: process.getgid?.() };
const initialize = (root: string) =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  const { initializeSupervisorState } = await import(process.argv[1]);
  await initializeSupervisorState(process.argv[2], JSON.parse(process.argv[3]), process.argv[4]);
`,
      supervisorUrl,
      root,
      JSON.stringify(owner),
      join(root, "workspace"),
    ],
    { stdio: "pipe" },
  );

it("initializes trusted state in successive supervisor processes without losing uploads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fullbeam-init-"));
  const root = join(dir, "state");
  try {
    initialize(root);
    await writeFile(
      join(root, "uploads/existing.data"),
      "retain uploaded bytes",
    );
    await chmod(join(root, "uploads"), 0o755);
    await chmod(join(root, "workspace"), 0o1777);
    initialize(root);
    expect(await readFile(join(root, "uploads/existing.data"), "utf8")).toBe(
      "retain uploaded bytes",
    );
    expect((await lstat(join(root, "workspace"))).mode & 0o7777).toBe(0o1777);
    for (const [path, mode] of [
      [root, 0o711],
      [join(root, "uploads"), 0o700],
      [join(root, "executions"), 0o700],
    ] as const) {
      const info = await lstat(path);
      expect(info.mode & 0o777).toBe(mode);
      expect(info.uid).toBe(owner.uid);
      expect(info.gid).toBe(owner.gid);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  "root-symlink",
  "uploads-symlink",
  "executions-file",
  "uploads-fifo",
  "workspace-symlink",
])("rejects %s instead of following or replacing it", async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), "fullbeam-init-reject-"));
  const root = join(dir, "state"),
    outside = join(dir, "outside");
  try {
    await mkdir(outside, { mode: 0o755 });
    if (kind === "root-symlink") await symlink(outside, root);
    else {
      await mkdir(root);
      if (kind === "uploads-symlink")
        await symlink(outside, join(root, "uploads"));
      else if (kind === "workspace-symlink")
        await symlink(outside, join(root, "workspace"));
      else if (kind === "uploads-fifo")
        execFileSync("mkfifo", [join(root, "uploads")]);
      else await writeFile(join(root, "executions"), "not a directory");
    }
    expect(() => initialize(root)).toThrow(
      /Unsafe supervisor (state|workspace) directory/,
    );
    expect((await lstat(outside)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses to adopt a state directory owned by a different identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fullbeam-init-owner-"));
  try {
    const { initializeSupervisorState } = await import(
      "../runtime/supervisor.mjs" as string
    );
    await expect(
      initializeSupervisorState(
        dir,
        { ...owner, uid: owner.uid! + 1 },
        join(dir, "workspace"),
      ),
    ).rejects.toThrow(/Unsafe supervisor state directory/);
    expect((await lstat(dir)).uid).toBe(owner.uid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
