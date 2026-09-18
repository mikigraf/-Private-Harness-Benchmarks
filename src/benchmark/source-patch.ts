import { digest, validateBundle, type FileEntry } from "../core/integrity.js";

export interface SourcePatchFile {
  content: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface SourcePatchEntry {
  path: string;
  operation: "ADD" | "MODIFY" | "DELETE";
  before: SourcePatchFile | null;
  after: SourcePatchFile | null;
}

export interface SourcePatch {
  schema_version: 1;
  entries: SourcePatchEntry[];
}

function isSource(path: string): boolean {
  return path.startsWith("src/");
}

function patchFile(file: FileEntry): SourcePatchFile {
  return {
    content: file.content,
    size: file.size,
    sha256: file.sha256,
    mode: file.mode,
  };
}

function sameFile(left: FileEntry, right: FileEntry): boolean {
  return (
    left.content === right.content &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode
  );
}

/** Replace the complete application source subtree while retaining frozen non-source inputs. */
export function replaceSourceSubtree(
  base: FileEntry[],
  accepted: FileEntry[],
): FileEntry[] {
  validateBundle(base);
  validateBundle(accepted);
  const result = [
    ...base.filter((file) => !isSource(file.path)),
    ...accepted.filter((file) => isSource(file.path)),
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  validateBundle(result);
  return result;
}

/** Canonical content-bearing patch. Both sides bind exact bytes and executable mode. */
export function sourcePatch(
  base: FileEntry[],
  reference: FileEntry[],
): SourcePatch {
  validateBundle(base);
  validateBundle(reference);
  const before = new Map(
    base.filter((file) => isSource(file.path)).map((file) => [file.path, file]),
  );
  const after = new Map(
    reference
      .filter((file) => isSource(file.path))
      .map((file) => [file.path, file]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
  const entries: SourcePatchEntry[] = [];
  for (const path of paths) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile && newFile && sameFile(oldFile, newFile)) continue;
    entries.push({
      path,
      operation: oldFile ? (newFile ? "MODIFY" : "DELETE") : "ADD",
      before: oldFile ? patchFile(oldFile) : null,
      after: newFile ? patchFile(newFile) : null,
    });
  }
  return { schema_version: 1, entries };
}

export function sourcePatchDigest(
  base: FileEntry[],
  reference: FileEntry[],
): string {
  return digest(sourcePatch(base, reference));
}
