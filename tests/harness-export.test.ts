import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config } from "../src/core/config.js";
import { makeFile } from "../src/core/integrity.js";
import { exportHarness } from "../src/product/harness-export.js";

it("exports editable native files with exact bytes and executable modes, without overwriting operator work", async () => {
  const root = await mkdtemp(join(tmpdir(), "fullbeam-harness-export-"));
  const directory = join(root, "harness");
  const config = {} as Config;
  const snapshot = {
    head: "a".repeat(40),
    files: [
      makeFile(".codex/config.toml", 'model="candidate-model"\n'),
      makeFile("skills.md", "Human skill index\n"),
      makeFile(
        ".agents/skills/check/scripts/check.sh",
        "#!/bin/sh\nexit 0\n",
        0o100755,
      ),
    ],
  };
  try {
    const result = await exportHarness(
      config,
      directory,
      {},
      {
        readSnapshot: async () => snapshot,
      },
    );
    expect(result.head).toBe(snapshot.head);
    expect(result.files).toEqual(snapshot.files.map((file) => file.path));
    for (const file of snapshot.files)
      expect(await readFile(join(directory, file.path))).toEqual(
        Buffer.from(file.content, "base64"),
      );
    expect(
      (await stat(join(directory, snapshot.files[2]!.path))).mode & 0o111,
    ).toBe(0o111);
    await writeFile(join(directory, "skills.md"), "Operator edits\n");
    await expect(
      exportHarness(
        config,
        directory,
        {},
        {
          readSnapshot: async () => snapshot,
        },
      ),
    ).rejects.toThrow(/new output directory/i);
    expect(await readFile(join(directory, "skills.md"), "utf8")).toBe(
      "Operator edits\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
