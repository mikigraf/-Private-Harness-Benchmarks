import Fastify from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Config, redact, secretsOf } from "../core/config.js";
import {
  DashboardData,
  validateStartInput,
  type DashboardDataSource,
} from "./data.js";

export function createDashboardServer(
  config: Config,
  options: { data?: DashboardDataSource } = {},
) {
  if (!options.data && !config.databaseUrl)
    throw new Error(
      "Dashboard persistence requires DATABASE_URL from the InstaCloud Postgres setup",
    );
  const app = Fastify({ logger: false, bodyLimit: 768 * 1024 });
  const data = options.data ?? new DashboardData(config);
  const csrfToken = randomBytes(32).toString("hex");
  let starting = false;
  app.addHook("onReady", async () => {
    await data.open?.();
  });
  app.addHook("onClose", async () => {
    await data.close?.();
  });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host))
      return reply.code(403).send({ error: "Loopback host required" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`)
      return reply.code(403).send({ error: "Same-origin request required" });
    if (!["GET", "HEAD"].includes(request.method)) {
      const token = request.headers["x-fullbeam-csrf"];
      if (
        origin !== `http://${host}` ||
        typeof token !== "string" ||
        token.length !== csrfToken.length ||
        Buffer.byteLength(token) !== Buffer.byteLength(csrfToken) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))
      )
        return reply
          .code(403)
          .send({ error: "Valid same-origin CSRF token required" });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });
  app.addHook("onSend", async (_request, _reply, payload) =>
    typeof payload === "string" ? redact(payload, secretsOf(config)) : payload,
  );
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as { statusCode?: number }).statusCode === 409 ? 409 : 400)
      .send({
        error: redact(
          error instanceof Error ? error.message : "Dashboard request failed",
          secretsOf(config),
        ),
      }),
  );
  for (const [route, file, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/styles.css", "styles.css", "text/css"],
  ]) {
    app.get(route!, async (_request, reply) =>
      reply
        .type(type!)
        .send(
          await readFile(new URL(`./public/${file}`, import.meta.url), "utf8"),
        ),
    );
  }
  app.get("/api/overview", async () => ({
    ...((await data.overview()) as object),
    csrfToken,
  }));
  app.get("/api/runs", async () => ({ runs: await data.listRuns() }));
  app.get("/api/jobs", async () => ({ jobs: (await data.jobs?.()) ?? [] }));
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    if (!/^[1-9][0-9]*$/.test(request.params.id))
      throw new Error("Invalid Actions run ID");
    return data.run(Number(request.params.id));
  });
  app.get("/api/harness", async () => data.harness());
  app.post<{ Params: { id: string; attemptId: string } }>(
    "/api/runs/:id/attempts/:attemptId/review-pr",
    async (request, reply) => {
      if (!/^[1-9][0-9]*$/.test(request.params.id))
        throw new Error("Invalid Actions run ID");
      if (
        request.body !== undefined &&
        request.body !== null &&
        (typeof request.body !== "object" ||
          Array.isArray(request.body) ||
          Object.keys(request.body as object).length)
      )
        throw new Error(
          "Review PRs use recorded artifacts only; request payloads are not accepted",
        );
      if (!data.reviewAttempt)
        throw new Error("Attempt review publishing is unavailable");
      return reply
        .code(201)
        .send(
          await data.reviewAttempt(
            Number(request.params.id),
            request.params.attemptId,
          ),
        );
    },
  );
  app.post("/api/runs", async (request, reply) => {
    const input = validateStartInput(request.body);
    if (starting)
      return reply.code(409).send({
        error: "A run is already being dispatched; wait for its receipt",
      });
    starting = true;
    try {
      return reply.code(202).send(await data.start(input));
    } finally {
      starting = false;
    }
  });
  return app;
}
export async function startDashboard(config: Config, port = 4318) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid dashboard port");
  const app = createDashboardServer(config);
  try {
    await app.listen({ host: "127.0.0.1", port });
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
