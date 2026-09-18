import { createHash } from "node:crypto";
import type { GitHubClient } from "./client.js";
import type {
  FrozenSourceTree,
  GitFileMode,
  SourceFileManifestEntry,
} from "./types.js";

interface GitTreeResponse {
  sha: string;
  truncated: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
    size?: number;
  }>;
}

interface GitBlobResponse {
  sha: string;
  encoding: string;
  content: string;
  size: number;
}

const SUPPORTED_FILE_MODES = new Set<GitFileMode>(["100644", "100755"]);

function assertSafePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe source path ${JSON.stringify(path)}`);
  }
}

function gitBlobSha(bytes: Uint8Array): string {
  const prefix = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(prefix).update(bytes).digest("hex");
}

export async function freezeSourceTree(
  client: GitHubClient,
  commitSha: string,
  options: {
    allowPaths?: readonly string[];
    allowPath?: (path: string) => boolean;
    maxBytes?: number;
  } = {},
): Promise<FrozenSourceTree> {
  const tree = await client.rest<GitTreeResponse>(
    "GET",
    `git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
  );
  if (tree.truncated)
    throw new Error(`GitHub returned a truncated source tree for ${commitSha}`);
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const allowed = options.allowPaths;
  for (const entry of tree.tree) {
    assertSafePath(entry.path);
    if (entry.type === "commit" || entry.mode === "160000")
      throw new Error(`Git submodules are not supported at ${entry.path}`);
    if (entry.mode === "120000")
      throw new Error(`Git symlinks are not supported at ${entry.path}`);
  }
  const entries = tree.tree
    .filter((entry) => entry.type === "blob")
    .filter(
      (entry) =>
        !allowed ||
        allowed.some(
          (path) =>
            entry.path === path ||
            entry.path.startsWith(`${path.replace(/\/$/, "")}/`),
        ),
    )
    .filter((entry) => !options.allowPath || options.allowPath(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length > 2_000)
    throw new Error("Frozen source exceeds 2000 files");
  let total = 0;
  const files: SourceFileManifestEntry[] = [];
  for (const entry of entries) {
    if (!SUPPORTED_FILE_MODES.has(entry.mode as GitFileMode))
      throw new Error(
        `Unsupported Git file mode ${entry.mode} at ${entry.path}`,
      );
    const blob = await client.rest<GitBlobResponse>(
      "GET",
      `git/blobs/${encodeURIComponent(entry.sha)}`,
    );
    if (blob.encoding !== "base64")
      throw new Error(`Unsupported Git blob encoding at ${entry.path}`);
    const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
    if (
      bytes.byteLength !== blob.size ||
      (entry.size !== undefined && bytes.byteLength !== entry.size)
    ) {
      throw new Error(`GitHub blob size mismatch at ${entry.path}`);
    }
    const calculatedGitSha = gitBlobSha(bytes);
    if (calculatedGitSha !== entry.sha || blob.sha !== entry.sha)
      throw new Error(`GitHub blob SHA mismatch at ${entry.path}`);
    total += bytes.byteLength;
    if (total > maxBytes)
      throw new Error(`Frozen source exceeds ${maxBytes} bytes`);
    files.push({
      path: entry.path,
      base64: bytes.toString("base64"),
      size: bytes.byteLength,
      gitBlobSha: entry.sha,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: entry.mode as GitFileMode,
    });
  }
  return { commitSha, treeSha: tree.sha, files };
}

export function diffFrozenTrees(
  base: FrozenSourceTree,
  accepted: FrozenSourceTree,
): string[] {
  const before = new Map(
    base.files.map((file) => [file.path, `${file.mode}:${file.gitBlobSha}`]),
  );
  const after = new Map(
    accepted.files.map((file) => [
      file.path,
      `${file.mode}:${file.gitBlobSha}`,
    ]),
  );
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}
