import type { GitHubClient } from "./client.js";

export const FULLBEAM_COMMENT_MARKER = "<!-- fullbeam:comparison-report -->";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderEscapedReport(title: string, reportText: string): string {
  const safeTitle = escapeHtml(title)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
  const safeReport = escapeHtml(reportText);
  return `${FULLBEAM_COMMENT_MARKER}\n## ${safeTitle}\n\n<pre><code>${safeReport}</code></pre>`;
}

interface CommentResponse {
  id: number;
  body: string;
  html_url: string;
}

export class GitHubPublisher {
  constructor(private readonly client: GitHubClient) {}

  async publish(input: {
    pullNumber: number;
    expectedHeadSha: string;
    title: string;
    reportText: string;
    allowOutdated?: true;
    check?: {
      name: "fullbeam / execution" | "fullbeam / evidence";
      conclusion: "success" | "failure" | "neutral";
      detailsUrl?: string;
    };
  }): Promise<{
    applicability: "CURRENT" | "OUTDATED";
    commentId: number;
    commentUrl: string;
    checkRunId?: number;
    checkRunUrl?: string;
    jobSummary: string;
  }> {
    const pull = await this.client.rest<{ head: { sha: string } }>(
      "GET",
      `pulls/${input.pullNumber}`,
    );
    const applicability =
      pull.head.sha === input.expectedHeadSha ? "CURRENT" : "OUTDATED";
    if (applicability === "OUTDATED" && input.allowOutdated !== true)
      throw new Error(
        "Pull request head changed; report is applicable only to the evaluated exact head",
      );
    const reportText =
      applicability === "OUTDATED"
        ? `${input.reportText}\n\nAPPLICABILITY: OUTDATED — evaluated ${input.expectedHeadSha}; current head ${pull.head.sha}.`
        : input.reportText;
    const body = renderEscapedReport(input.title, reportText);
    const comments = await this.client.paginate<CommentResponse>(
      `issues/${input.pullNumber}/comments`,
      { per_page: 100 },
    );
    const marked = comments.filter((comment) =>
      comment.body.includes(FULLBEAM_COMMENT_MARKER),
    );
    if (marked.length > 1)
      throw new Error(
        "Multiple Fullbeam report comments exist; refusing to choose or delete user-visible history",
      );
    const comment = marked[0]
      ? await this.client.rest<CommentResponse>(
          "PATCH",
          `issues/comments/${marked[0].id}`,
          { body },
        )
      : await this.client.rest<CommentResponse>(
          "POST",
          `issues/${input.pullNumber}/comments`,
          { body },
        );
    if (!input.check)
      return {
        applicability,
        commentId: comment.id,
        commentUrl: comment.html_url,
        jobSummary: body,
      };
    const check = await this.client.rest<{ id: number; html_url: string }>(
      "POST",
      "check-runs",
      {
        name: input.check.name,
        head_sha: input.expectedHeadSha,
        status: "completed",
        conclusion: input.check.conclusion,
        completed_at: new Date().toISOString(),
        details_url: input.check.detailsUrl,
        output: {
          title: escapeHtml(input.title).slice(0, 255),
          summary: escapeHtml(reportText).slice(0, 65_535),
        },
      },
    );
    return {
      applicability,
      commentId: comment.id,
      commentUrl: comment.html_url,
      checkRunId: check.id,
      checkRunUrl: check.html_url,
      jobSummary: body,
    };
  }
}
