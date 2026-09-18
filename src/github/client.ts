import type { GitHubClientOptions, GitHubRepositoryIdentity } from "./types.js";

const DEFAULT_API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly method: string;
  readonly resource: string;

  constructor(input: {
    status: number;
    requestId?: string;
    method: string;
    resource: string;
  }) {
    const requestSuffix = input.requestId
      ? ` (request ${input.requestId})`
      : "";
    super(
      `GitHub API ${input.method} ${input.resource} failed with HTTP ${input.status}${requestSuffix}`,
    );
    this.name = "GitHubApiError";
    this.status = input.status;
    this.requestId = input.requestId;
    this.method = input.method;
    this.resource = input.resource;
  }
}

export class GitHubRequestTimeoutError extends Error {
  readonly method: string;
  readonly resource: string;
  readonly timeoutMs: number;

  constructor(input: { method: string; resource: string; timeoutMs: number }) {
    super(
      `GitHub API ${input.method} ${input.resource} timed out after ${input.timeoutMs}ms`,
    );
    this.name = "GitHubRequestTimeoutError";
    this.method = input.method;
    this.resource = input.resource;
    this.timeoutMs = input.timeoutMs;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class GitHubClient {
  readonly repository: Readonly<
    Required<Pick<GitHubRepositoryIdentity, "owner" | "repo">> &
      GitHubRepositoryIdentity
  >;
  readonly apiBaseUrl: string;
  readonly graphqlUrl: string;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: GitHubClientOptions) {
    const owner = options.repository.owner.trim();
    const repo = options.repository.repo.trim();
    if (!owner || !repo)
      throw new Error("GitHub owner and repository are required");
    if (!options.token) throw new Error("GitHub token is required");
    this.token = options.token;
    this.repository = { ...options.repository, owner, repo };
    this.apiBaseUrl = (
      options.repository.apiBaseUrl ?? "https://api.github.com"
    ).replace(/\/$/, "");
    this.graphqlUrl =
      options.repository.graphqlUrl ?? `${this.apiBaseUrl}/graphql`;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.userAgent = options.userAgent ?? "fullbeam-compare";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      this.requestTimeoutMs > 30_000
    ) {
      throw new Error(
        "GitHub request timeout must be a positive integer no greater than 30000ms",
      );
    }
  }

  isAuthenticationToken(value: string): boolean {
    return value === this.token;
  }

  repoUrl(suffix = ""): URL {
    const prefix = `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.repo)}`;
    const normalizedSuffix = suffix.replace(/^\//, "");
    const pathOnly = normalizedSuffix.split("?", 1)[0] ?? "";
    if (pathOnly.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("GitHub request is outside the authorized repository");
    }
    const url = new URL(
      normalizedSuffix ? `${prefix}/${normalizedSuffix}` : prefix,
      this.apiBaseUrl,
    );
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      throw new Error("GitHub request is outside the authorized repository");
    return url;
  }

  async rest<T>(method: Method, suffix: string, body?: unknown): Promise<T> {
    return this.requestJson<T>(method, this.repoUrl(suffix), body);
  }

  async accountRest<T>(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const allowed =
      path === "/user" ||
      path === "/user/repos" ||
      path === `/orgs/${encodeURIComponent(this.repository.owner)}/repos` ||
      path ===
        `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.repo)}`;
    if (!allowed)
      throw new Error(
        "GitHub account request is outside the authorized repository owner",
      );
    return this.requestJson<T>(method, new URL(path, this.apiBaseUrl), body);
  }

  async authenticatedActor(): Promise<{ id: number; login: string }> {
    return this.accountRest<{ id: number; login: string }>("GET", "/user");
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.requestJson<{ data?: T; errors?: unknown[] }>(
      "POST",
      new URL(this.graphqlUrl),
      { query, variables },
    );
    if (!response.data || (response.errors && response.errors.length > 0)) {
      throw new GitHubApiError({
        status: 200,
        method: "POST",
        resource: "/graphql",
      });
    }
    return response.data;
  }

  async paginate<T>(
    suffix: string,
    query: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    let next: URL | undefined = this.repoUrl(suffix);
    for (const [key, value] of Object.entries(query))
      next.searchParams.set(key, String(value));
    const values: T[] = [];
    while (next) {
      this.assertAuthorizedRepoUrl(next);
      const response = await this.requestRaw("GET", next);
      const page = (await response.json()) as T[];
      if (!Array.isArray(page))
        throw new Error("GitHub paginated response was not an array");
      values.push(...page);
      next = this.nextLink(response.headers.get("link"));
    }
    return values;
  }

  async paginateByField<T>(
    suffix: string,
    field: string,
    query: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    let next: URL | undefined = this.repoUrl(suffix);
    for (const [key, value] of Object.entries(query))
      next.searchParams.set(key, String(value));
    const values: T[] = [];
    while (next) {
      this.assertAuthorizedRepoUrl(next);
      const response = await this.requestRaw("GET", next);
      const envelope = (await response.json()) as Record<string, unknown>;
      const page = envelope[field];
      if (!Array.isArray(page))
        throw new Error(
          `GitHub paginated response field ${field} was not an array`,
        );
      values.push(...(page as T[]));
      next = this.nextLink(response.headers.get("link"));
    }
    return values;
  }

  async download(suffix: string): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", this.repoUrl(suffix));
    return new Uint8Array(await response.arrayBuffer());
  }

  private async requestJson<T>(
    method: Method,
    url: URL,
    body?: unknown,
  ): Promise<T> {
    const response = await this.requestRaw(method, url, body);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestRaw(
    method: Method,
    url: URL,
    body?: unknown,
  ): Promise<Response> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "follow",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "user-agent": this.userAgent,
          "x-github-api-version": this.apiVersion,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted)
        throw new GitHubRequestTimeoutError({
          method,
          resource: url.pathname,
          timeoutMs: this.requestTimeoutMs,
        });
      throw error;
    }
    if (!response.ok) {
      throw new GitHubApiError({
        status: response.status,
        requestId: response.headers.get("x-github-request-id") ?? undefined,
        method,
        resource: url.pathname,
      });
    }
    return response;
  }

  private assertAuthorizedRepoUrl(url: URL): void {
    const base = new URL(this.apiBaseUrl);
    const prefix = `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.repo)}/`;
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
      throw new Error("GitHub pagination escaped the authorized repository");
    }
  }

  private nextLink(header: string | null): URL | undefined {
    if (!header) return undefined;
    for (const part of header.split(",")) {
      const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
      if (match?.[2] === "next" && match[1]) return new URL(match[1]);
    }
    return undefined;
  }
}
