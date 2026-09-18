import Fastify from "fastify";
import { fixtureTenant } from "./auth/fixture-tenant.js";
import { decodeCursor, encodeCursor, isAfterCursor, type EventCursor } from "./events/cursor.js";
import { publicEvent } from "./events/model.js";
import { MemoryEventRepository } from "./events/repository.js";
import { EventConflictError, EventService } from "./events/service.js";

export interface AppDependencies {
  now(): string;
  nextId(): string;
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false });
  const repository = new MemoryEventRepository();
  const service = new EventService(repository, dependencies);

  app.get("/health", async () => ({ ok: true }));

  app.post("/events", async (request, reply) => {
    const tenantId = fixtureTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });
    if (!validCreateBody(request.body)) return reply.code(400).send({ error: "invalid_request" });
    const keyHeader = request.headers["idempotency-key"];
    if (Array.isArray(keyHeader)) return reply.code(400).send({ error: "invalid_request" });
    const key = typeof keyHeader === "string" && keyHeader.length > 0 ? keyHeader : undefined;
    try {
      const result = service.create(tenantId, request.body.type, request.body.payload, key);
      return reply.code(result.replayed ? 200 : 201).send({ event: publicEvent(result.event) });
    } catch (error) {
      if (error instanceof EventConflictError) return reply.code(409).send({ error: "idempotency_conflict" });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
    const tenantId = fixtureTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });
    const event = service.get(tenantId, request.params.id);
    return event
      ? reply.code(200).send({ event: publicEvent(event) })
      : reply.code(404).send({ error: "not_found" });
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/events", async (request, reply) => {
    const tenantId = fixtureTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });
    const limit = parseLimit(request.query.limit);
    if (limit === undefined) return reply.code(400).send({ error: "invalid_request" });
    let cursor: EventCursor | undefined;
    try {
      cursor = request.query.cursor === undefined ? undefined : decodeCursor(request.query.cursor);
    } catch {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (cursor && cursor.tenantId !== tenantId) return reply.code(400).send({ error: "invalid_request" });
    const ordered = service.list(tenantId).filter((event) => !cursor || isAfterCursor(event, cursor));
    const page = ordered.slice(0, limit);
    const nextCursor = ordered.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;
    return { events: page.map(publicEvent), nextCursor };
  });

  return app;
}

function validCreateBody(value: unknown): value is { type: string; payload: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === "string" && candidate.type.trim().length > 0 &&
    !!candidate.payload && typeof candidate.payload === "object" && !Array.isArray(candidate.payload);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 20;
  if (!/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}
