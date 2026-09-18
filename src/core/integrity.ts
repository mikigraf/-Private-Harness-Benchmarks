import { createHash } from "node:crypto";
import { posix } from "node:path";
export interface FileEntry {
  path: string;
  content: string;
  size: number;
  sha256: string;
  mode: number;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  throw new Error(
    "Noncanonical JSON value (undefined, nonfinite number, or unsupported object)",
  );
}
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const digest = (value: unknown): string => sha256(canonical(value));
export function recordDigest(record: Record<string, unknown>): string {
  const { digest: _, ...payload } = record;
  return digest(payload);
}
export function normalizePath(path: string): string {
  if (
    !path ||
    path.length > 500 ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p === ".git") ||
    posix.normalize(path) !== path
  )
    throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
  return path;
}
export function makeFile(
  path: string,
  contents: string | Uint8Array,
  mode = 0o100644,
): FileEntry {
  const data = Buffer.from(contents);
  return {
    path: normalizePath(path),
    content: data.toString("base64"),
    size: data.length,
    sha256: sha256(data),
    mode,
  };
}
export function validateBundle(
  files: FileEntry[],
  limits = { bytes: 16 * 1024 * 1024, files: 2000 },
): void {
  if (files.length > limits.files)
    throw new Error("Bundle file limit exceeded");
  let size = 0;
  const seen = new Set<string>();
  for (const f of files) {
    normalizePath(f.path);
    if (seen.has(f.path)) throw new Error(`Duplicate bundle path: ${f.path}`);
    seen.add(f.path);
    if (![0o100644, 0o100755, 0o644, 0o755].includes(f.mode))
      throw new Error(`Unsupported file mode: ${f.path}`);
    const bytes = Buffer.from(f.content, "base64");
    if (
      bytes.toString("base64") !== f.content ||
      bytes.length !== f.size ||
      sha256(bytes) !== f.sha256
    )
      throw new Error(`Bundle integrity failure: ${f.path}`);
    size += f.size;
  }
  if (size > limits.bytes) throw new Error("Bundle byte limit exceeded");
  for (const path of seen) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/")))
        throw new Error(`File/directory collision: ${path}`);
      parts.pop();
    }
  }
}
export function manifestDigest(files: FileEntry[]): string {
  validateBundle(files);
  return digest(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
      .map(({ content: _, ...f }) => f),
  );
}
export function overlayFiles(
  base: FileEntry[],
  changes: FileEntry[],
): FileEntry[] {
  validateBundle(base);
  validateBundle(changes);
  const map = new Map(base.map((f) => [f.path, f]));
  for (const f of changes) map.set(f.path, f);
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function validateSubmittedFiles(
  base: FileEntry[],
  after: FileEntry[],
): {
  violations: string[];
  source: FileEntry[];
  changed: string[];
  deleted: string[];
} {
  validateBundle(base);
  validateBundle(after);
  const a = new Map(base.map((f) => [f.path, f]));
  const b = new Map(after.map((f) => [f.path, f]));
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter(
    (p) =>
      a.get(p)?.sha256 !== b.get(p)?.sha256 ||
      a.get(p)?.mode !== b.get(p)?.mode,
  );
  const violations = changed.filter(
    (p) =>
      p === "AGENTS.md" ||
      p.endsWith("/AGENTS.md") ||
      (!p.startsWith("src/") &&
        !(p.startsWith("tests/agent/") && !a.has(p) && b.has(p))),
  );
  return {
    violations,
    source: after.filter((f) => f.path.startsWith("src/")),
    changed,
    deleted: changed.filter((p) => !b.has(p)),
  };
}
