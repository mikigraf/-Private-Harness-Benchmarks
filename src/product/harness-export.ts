import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "../core/config.js";
import { readHarnessSnapshot } from "./harness.js";
import { writeBundle } from "./files.js";

/** Export into a new directory so existing operator edits are never overwritten. */
export async function exportHarness(
  config: Config,
  output: string,
  options: { ref?: string } = {},
  dependencies: { readSnapshot?: typeof readHarnessSnapshot } = {},
): Promise<{ head: string; directory: string; files: string[] }> {
  const snapshot = await (dependencies.readSnapshot ?? readHarnessSnapshot)(
    config,
    options,
  );
  const directory = resolve(output);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Harness export requires a new output directory; existing files were not changed",
      );
    throw error;
  }
  await writeBundle(directory, snapshot.files);
  return {
    head: snapshot.head,
    directory,
    files: snapshot.files.map((file) => file.path),
  };
}
