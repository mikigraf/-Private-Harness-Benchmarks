import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

const owner = { uid: process.getuid?.(), gid: process.getgid?.() };
const runtime = () => import("../runtime/supervisor.mjs" as string);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fullbeam-metadata-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await chmod(workspace, 0o1777);
  for (const [path, content, mode] of [
    [".git/config", "[core]\nrepositoryformatversion=0\n", 0o644],
    [".codex/config.toml", 'sandbox_mode="workspace-write"\n', 0o644],
    [".agents/skills/fixture/SKILL.md", "Frozen skill\n", 0o644],
    [".agents/skills/fixture/scripts/check", "#!/bin/sh\nexit 0\n", 0o755],
    ["AGENTS.md", "Frozen instructions\n", 0o644],
    ["skills.md", "Frozen human index\n", 0o644],
    ["src/app.js", "export const value=1;\n", 0o644],
  ] as const) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content, { mode });
  }
  return { root, workspace };
}

async function cleanup(root: string) {
  // A non-root test runner owns the sealed fixture and can restore permissions.
  async function restore(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    await chmod(path, 0o755);
    for (const entry of await readdir(path)) await restore(join(path, entry));
  }
  await restore(root);
  await rm(root, { recursive: true, force: true });
}

it("seals native metadata without changing bytes or executable identity", async () => {
  const f = await fixture();
  try {
    const { sealNativeMetadata } = await runtime();
    const protectedFiles = [
      ".git/config",
      ".codex/config.toml",
      ".agents/skills/fixture/SKILL.md",
      ".agents/skills/fixture/scripts/check",
      "AGENTS.md",
      "skills.md",
    ];
    const digest = async (path: string) =>
      createHash("sha256")
        .update(await readFile(join(f.workspace, path)))
        .digest("hex");
    const before = await Promise.all(protectedFiles.map(digest));

    await sealNativeMetadata(f.workspace, owner);
    await sealNativeMetadata(f.workspace, owner);

    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
    for (const path of [".git", ".codex", ".agents", ...protectedFiles]) {
      const info = await lstat(join(f.workspace, path));
      expect(info.uid).toBe(owner.uid);
      expect(info.gid).toBe(owner.gid);
      expect(info.mode & 0o222).toBe(0);
    }
    expect(
      (await lstat(join(f.workspace, ".agents/skills/fixture/scripts/check")))
        .mode & 0o111,
    ).toBe(0o111);
    expect((await lstat(join(f.workspace, "AGENTS.md"))).mode & 0o111).toBe(0);
    expect((await lstat(f.workspace)).mode & 0o7777).toBe(0o1777);
    expect((await lstat(join(f.workspace, "src/app.js"))).mode & 0o777).toBe(
      0o644,
    );
    await writeFile(join(f.workspace, "src/app.js"), "source remains editable");
  } finally {
    await cleanup(f.root);
  }
});

it.each(["root-symlink", "nested-symlink", "fifo", "hardlink", "root-file"])(
  "rejects unsafe metadata %s without modifying an external target",
  async (kind) => {
    const f = await fixture();
    try {
      const { sealNativeMetadata } = await runtime();
      const outside = join(f.root, "outside");
      await writeFile(outside, "external bytes", { mode: 0o644 });
      if (kind === "root-symlink" || kind === "root-file") {
        await rm(join(f.workspace, ".codex"), { recursive: true });
        if (kind === "root-symlink")
          await symlink(outside, join(f.workspace, ".codex"));
        else await writeFile(join(f.workspace, ".codex"), "not a directory");
      } else if (kind === "nested-symlink")
        await symlink(outside, join(f.workspace, ".agents/link"));
      else if (kind === "hardlink")
        await link(outside, join(f.workspace, ".agents/linked-file"));
      else execFileSync("mkfifo", [join(f.workspace, ".agents/pipe")]);

      await expect(sealNativeMetadata(f.workspace, owner)).rejects.toThrow(
        /unsafe native metadata/i,
      );
      expect(await readFile(outside, "utf8")).toBe("external bytes");
      expect((await lstat(outside)).mode & 0o777).toBe(0o644);
    } finally {
      await cleanup(f.root);
    }
  },
);

it("requires the sticky workspace boundary before trusting sealed roots", async () => {
  const f = await fixture();
  try {
    const { sealNativeMetadata } = await runtime();
    await chmod(f.workspace, 0o777);
    await expect(sealNativeMetadata(f.workspace, owner)).rejects.toThrow(
      /workspace.*ownership.*sticky/i,
    );
    await chmod(f.workspace, 0o1777);
    await expect(
      sealNativeMetadata(f.workspace, { ...owner, uid: owner.uid! + 1 }),
    ).rejects.toThrow(/workspace.*ownership.*sticky/i);
  } finally {
    await cleanup(f.root);
  }
});

it("creates only empty metadata directories for a bare capability fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "fullbeam-empty-metadata-"));
  try {
    const { sealNativeMetadata } = await runtime();
    await chmod(root, 0o1777);
    await writeFile(join(root, "probe.txt"), "declared input");
    await sealNativeMetadata(root, owner);
    expect((await readdir(root)).sort()).toEqual([
      ".agents",
      ".codex",
      ".git",
      "probe.txt",
    ]);
    for (const path of [".agents", ".codex", ".git"])
      expect(await readdir(join(root, path))).toEqual([]);
    expect(await readFile(join(root, "probe.txt"), "utf8")).toBe(
      "declared input",
    );
  } finally {
    await cleanup(root);
  }
});
