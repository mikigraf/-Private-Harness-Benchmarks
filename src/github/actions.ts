import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { GitHubApiError, type GitHubClient } from "./client.js";
import type {
  ImmutableCheckpointArtifact,
  ImmutableCheckpointArtifactWriter,
} from "./types.js";

function validateActionsName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error(
      "GitHub Actions secret and variable names must use uppercase letters, digits, and underscores",
    );
}

export interface WorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  head_sha: string;
  event: string;
  created_at: string;
  html_url: string;
}

export interface ActionsArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string;
  expires_at: string;
}

export class GitHubActions {
  constructor(private readonly client: GitHubClient) {}

  async putSecret(name: string, value: string): Promise<void> {
    validateActionsName(name);
    if (!value) throw new Error("GitHub Actions secret value is required");
    if (name === "GITHUB_TOKEN" || this.client.isAuthenticationToken(value)) {
      throw new Error(
        "The GitHub authentication token must never be uploaded as an Actions secret",
      );
    }
    const publicKey = await this.client.rest<{ key_id: string; key: string }>(
      "GET",
      "actions/secrets/public-key",
    );
    await sodium.ready;
    const keyBytes = sodium.from_base64(
      publicKey.key,
      sodium.base64_variants.ORIGINAL,
    );
    const encrypted = sodium.crypto_box_seal(
      sodium.from_string(value),
      keyBytes,
    );
    await this.client.rest<void>(
      "PUT",
      `actions/secrets/${encodeURIComponent(name)}`,
      {
        encrypted_value: sodium.to_base64(
          encrypted,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: publicKey.key_id,
      },
    );
  }

  async upsertVariable(name: string, value: string): Promise<void> {
    validateActionsName(name);
    // Optional blank .env settings mean unset. GitHub rejects empty values;
    // skipping the write would leave a previously configured value active.
    if (value === "") {
      try {
        await this.client.rest<void>(
          "DELETE",
          `actions/variables/${encodeURIComponent(name)}`,
        );
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404)
          throw error;
      }
      return;
    }
    try {
      await this.client.rest(
        "GET",
        `actions/variables/${encodeURIComponent(name)}`,
      );
      await this.client.rest<void>(
        "PATCH",
        `actions/variables/${encodeURIComponent(name)}`,
        { name, value },
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404)
        throw error;
      await this.client.rest<void>("POST", "actions/variables", {
        name,
        value,
      });
    }
  }

  async dispatchWorkflow(input: {
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<{ dispatchedAt: string }> {
    if (!input.workflow || !input.ref)
      throw new Error("Workflow and protected ref are required");
    const dispatchedAt = new Date().toISOString();
    await this.client.rest<void>(
      "POST",
      `actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
      { ref: input.ref, inputs: input.inputs },
    );
    return { dispatchedAt };
  }

  async pollWorkflowRun(input: {
    workflow: string;
    expectedHeadSha: string;
    dispatchedAt: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<WorkflowRun> {
    const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
    const dispatchedTime = Date.parse(input.dispatchedAt);
    if (!Number.isFinite(dispatchedTime))
      throw new Error("Invalid workflow dispatch timestamp");
    while (Date.now() <= deadline) {
      const response = await this.client.rest<{ workflow_runs: WorkflowRun[] }>(
        "GET",
        `actions/workflows/${encodeURIComponent(input.workflow)}/runs?event=workflow_dispatch&per_page=100`,
      );
      const matches = response.workflow_runs.filter(
        (run) =>
          run.event === "workflow_dispatch" &&
          run.head_sha === input.expectedHeadSha &&
          Date.parse(run.created_at) >= dispatchedTime - 5_000,
      );
      if (matches.length > 1)
        throw new Error(
          "Workflow dispatch matched multiple runs; refusing ambiguous attribution",
        );
      const match = matches[0];
      if (match?.status === "completed") return match;
      await new Promise((resolve) =>
        setTimeout(resolve, input.pollIntervalMs ?? 2_000),
      );
    }
    throw new Error(
      "Timed out waiting for the dispatched GitHub Actions workflow",
    );
  }

  async listRunArtifacts(runId: number): Promise<ActionsArtifact[]> {
    return this.client.paginateByField<ActionsArtifact>(
      `actions/runs/${runId}/artifacts`,
      "artifacts",
      { per_page: 100 },
    );
  }

  async downloadRunArtifact(
    runId: number,
    artifactName: string,
  ): Promise<{ artifact: ActionsArtifact; zip: Uint8Array; sha256: string }> {
    const artifacts = (await this.listRunArtifacts(runId)).filter(
      (artifact) => artifact.name === artifactName && !artifact.expired,
    );
    if (artifacts.length !== 1 || !artifacts[0])
      throw new Error(`Expected one unexpired artifact named ${artifactName}`);
    const zip = await this.client.download(
      `actions/artifacts/${artifacts[0].id}/zip`,
    );
    return {
      artifact: artifacts[0],
      zip,
      sha256: createHash("sha256").update(zip).digest("hex"),
    };
  }

  async writeImmutableCheckpoint(
    writer: ImmutableCheckpointArtifactWriter,
    input: {
      name: string;
      files: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
    },
  ): Promise<ImmutableCheckpointArtifact> {
    const files = input.files.map((file) => ({
      ...file,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    }));
    const receipt = await writer.writeCheckpoint({ name: input.name, files });
    if (
      !receipt.immutable ||
      receipt.name !== input.name ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256)
    ) {
      throw new Error(
        "Checkpoint writer did not return an immutable digest-bearing artifact receipt",
      );
    }
    return receipt;
  }
}
