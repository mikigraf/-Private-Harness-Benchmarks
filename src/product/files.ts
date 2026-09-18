import { readdir, readFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { makeFile, validateBundle, type FileEntry } from "../core/integrity.js";
import type { SourceFileManifestEntry } from "../github/types.js";
export function fromGitFiles(files: SourceFileManifestEntry[]): FileEntry[] {
  const output = files.map((f) => ({
    path: f.path,
    content: f.base64,
    size: f.size,
    sha256: f.sha256,
    mode: Number.parseInt(f.mode, 8),
  }));
  validateBundle(output);
  return output;
}
export async function readDirectory(
  root: string,
  prefix = "",
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".DS_Store"].includes(d.name))
      continue;
    if (d.isSymbolicLink())
      throw new Error("Symlinks are not accepted in exported files");
    const path = join(root, d.name),
      relative = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) result.push(...(await readDirectory(path, relative)));
    else if (d.isFile()) {
      const st = await lstat(path);
      if (st.nlink > 1) throw new Error("Hardlinked input file");
      result.push(
        makeFile(
          relative,
          await readFile(path),
          st.mode & 0o111 ? 0o100755 : 0o100644,
        ),
      );
    }
  }
  return result;
}
export async function writeBundle(
  root: string,
  files: FileEntry[],
): Promise<void> {
  validateBundle(files);
  for (const f of files) {
    const path = join(root, f.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(f.content, "base64"), {
      mode: f.mode & 0o777,
    });
  }
}
export function gitCommitFiles(
  files: FileEntry[],
): { path: string; content: Uint8Array; mode: "100644" | "100755" }[] {
  validateBundle(files);
  return files.map((f) => ({
    path: f.path,
    content: Buffer.from(f.content, "base64"),
    mode: f.mode & 0o111 ? "100755" : "100644",
  }));
}
export const APPLICATION_PATHS = [
  "src",
  "tests/public",
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
];
