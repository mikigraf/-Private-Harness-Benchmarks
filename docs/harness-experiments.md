# Compare models and harness versions

Keep credentials, account settings, and bootstrap defaults in the root `.env`. Each evaluated release is a Git commit containing its own native Codex settings and instructions. Once a repository is initialized, changing `FULLBEAM_MODEL` or `FULLBEAM_REASONING_EFFORT` in `.env` does not rewrite its existing releases. Use a harness proposal to change them reproducibly.

## Change the model or reasoning effort

From this Fullbeam checkout, create an experiment against the prepared repository:

```sh
npm run fullbeam -- harness propose --name model-experiment \
  --model YOUR_AVAILABLE_MODEL_ID --reasoning-effort medium
```

Use an exact model identifier that your OpenAI API key can call and a reasoning effort supported by that model. The command opens an owned PR containing the changed `.codex/config.toml`, then prints its PR number, frozen head, classification, and comparison command. Run that command:

```sh
npm run compare -- --pr 123
```

Both sides run against the same frozen tasks and grading policy. Each side gets the model and effort from its own commit. A model unavailable to your key is reported as a configuration error; the controller does not substitute a different model.

## Edit instructions and skills

Export the current protected default-branch harness to a **new** directory:

```sh
npm run fullbeam -- harness export --out .fullbeam-state/my-harness
```

The command prints the exact source commit. To start from another recorded version, add `--ref COMMIT_SHA`. Existing directories are refused so local edits are not overwritten.

Edit these files in the exported directory:

| File                           | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `.codex/config.toml`           | Native model and reasoning effort, with fixed sandbox/approval/web-search settings. |
| `AGENTS.md`                    | Instructions loaded for the repository.                                             |
| `skills.md`                    | Human-readable skill index and harness documentation.                               |
| `.agents/skills/NAME/SKILL.md` | Actual native skill instructions, including `name` and `description` frontmatter.   |
| `.agents/skills/NAME/**`       | Supporting resources for that skill.                                                |

Editing only `skills.md` changes the index; edit a native `SKILL.md` to change that skill's instructions. Preserve the metadata required by Codex. Harness files are frozen and protected during evaluation, while the agent can work on the allowed application paths.

Submit the edited files:

```sh
npm run fullbeam -- harness propose --name tenant-skill-v2 \
  --overlay .fullbeam-state/my-harness
npm run compare -- --pr 123
```

The overlay adds or replaces included files. Omitted files remain unchanged; deletion is not implied. You can combine an overlay with `--model` and `--reasoning-effort`; explicit flags override values in the overlay. The proposal command restricts changes to the supported harness files and rejects application code, workflows, credential files outside the allowlist (such as `.env`), links, and unsafe permission settings. Allowed instruction and skill text is not a secret scanner; keep credentials in the root `.env`. Rerunning the same named proposal updates its owned branch only when it is safe to do so. It does not force-push or adopt unrelated work.

For a deletion or other supported Git-level harness edit, use a normal PR in the prepared repository and run `npm run compare -- --pr NUMBER`. Mixed application/controller/benchmark changes are rejected at comparison intake. The current release comes from the protected default branch and the candidate comes from the exact PR head. Merge a reviewed proposal through GitHub to make it the current release for future experiments; comparisons do not merge proposals automatically.

## Read the result

Reports retain both model identifiers, reasoning efforts, immutable release digests, all scheduled outcomes, measured usage, and cleanup evidence. The configuration classification is:

- `MODEL_ONLY`: model or reasoning effort changed.
- `HARNESS_ONLY`: instruction, skill, or other supported harness content changed.
- `BUNDLE`: both changed; a result cannot be attributed to either change alone.

No-change or incomplete historical metadata is labeled `UNCHANGED` or `UNKNOWN` where applicable. The two repeats per task are a small pipeline demonstration, not a statistical model ranking or production approval.

The three legacy `.env` token rates apply only to the matching configured model. Per-model overrides in `FULLBEAM_MODEL_RATES_JSON` take precedence; otherwise the verified Sol, Astra, and Luna catalog supplies an estimate. Unknown models retain visible usage with unknown cost; baseline pricing is never applied to another model. Each run freezes its rate source and limitations. See [dashboard cost accounting](dashboard.md#models-and-cost). A configured cost threshold selects one evaluation worker. Otherwise the controller runs up to two isolated pipelines at once, with independent generation and verification environments for every attempt.

A native Codex executable upgrade is a runtime change, separate from model/skill authoring. It requires a pinned runtime build, capability preflight, and recalibration. The current hosted runtime pins Codex 0.125.0; see [runtime compatibility](instacloud-runtime-blocker.md).
