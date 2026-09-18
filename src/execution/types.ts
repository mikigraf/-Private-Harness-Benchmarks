export interface FileEntry {
  path: string;
  content: string;
  size: number;
  sha256: string;
  mode: number;
}
export interface FileBundle {
  files: FileEntry[];
}
export type Role = "generation" | "verification";
export interface EnvironmentSpec {
  id: string;
  role: Role;
}
export interface EnvironmentRef extends EnvironmentSpec {
  projectId: string;
  branch: string;
  providerId?: string;
}
export interface AttemptInput {
  role: Role;
  timeoutSeconds: number;
  taskId?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  allowedWritePaths?: string[];
  protectedPaths?: string[];
  verifierModuleBase64?: string;
  verifierSha256?: string;
  /** Trusted controller-selected argv, never taken from a harness. */
  buildCommand?: string[];
  startCommand?: string[];
  port?: number;
  capabilityProbe?: boolean;
  nativeVersion?: string;
  maxOutputBytes?: number;
}
export interface RemoteExecutionRef {
  environment: EnvironmentRef;
  executionId: string;
}
export interface ExecutionStatus {
  executionId: string;
  state: "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  endedAt?: string;
  error?: string;
}
export interface CheckResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
}
export interface ArtifactManifest {
  executionId: string;
  role: Role;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentDurationMs?: number | null;
  effectiveNativeSettings?: Record<string, unknown>;
  status:
    | "COMPLETED"
    | "AGENT_TIMEOUT"
    | "AGENT_ERROR"
    | "CANDIDATE_CONFIG_ERROR"
    | "FUNCTIONAL_FAIL"
    | "INFRA_ERROR"
    | "POLICY_VIOLATION";
  exitCode: number | null;
  buildPassed?: boolean;
  startupPassed?: boolean;
  checks: CheckResult[];
  failureKind?: "APPLICATION_EXIT" | "VERIFICATION_TIMEOUT";
  files: FileEntry[];
  beforeManifest: Omit<FileEntry, "content">[];
  afterManifest: Omit<FileEntry, "content">[];
  violations: string[];
  events: string;
  stderr: string;
  logsTruncated: boolean;
  usage: unknown[];
  excludedPaths?: string[];
  nativeVersion?: string;
  nativeConfigSha256?: string;
  nativeComponents?: {
    path: string;
    sha256: string;
    materialized: "YES";
    exposed: "UNKNOWN";
    observedUse: "UNKNOWN";
  }[];
  integrityVerified: boolean;
  error?: string;
}
export interface CapabilityReport {
  status: "READY" | "BLOCKED";
  checkedAt: string;
  cliVersion?: string;
  schemaHash?: string;
  schemaSnapshot?: unknown;
  runtimeImages?: Record<Role, string>;
  region: string;
  observations: Record<string, unknown>;
  blockers: string[];
}
export type CliTransport = (
  args: string[],
  context: { projectId?: string; branch?: string },
) => Promise<unknown>;
export interface ExecutorOptions {
  apiKey: string;
  orgId: string;
  generationProjectId: string;
  verifierProjectId: string;
  region?: string;
  cliPath?: string;
  openaiApiKey?: string;
  model?: string;
  runtimeImages?: Record<Role, string>;
  onEnvironmentIntent?: (environment: EnvironmentRef) => Promise<void>;
  onEnvironmentAllocated?: (environment: EnvironmentRef) => Promise<void>;
  /** Absolute controller deadline. Cleanup clears it before issuing deletion RPCs. */
  operationDeadline?: () => number | undefined;
  transport?: CliTransport;
}
