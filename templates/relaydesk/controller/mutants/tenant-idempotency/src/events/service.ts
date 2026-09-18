import type { AppDependencies } from "../app.js";
import type { EventRecord } from "./model.js";
import { MemoryEventRepository } from "./repository.js";

export class EventConflictError extends Error {}

interface IdempotencyRecord { fingerprint: string; event: EventRecord }

export class EventService {
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(private readonly repository: MemoryEventRepository, private readonly dependencies: AppDependencies) {}

  create(tenantId: string, type: string, payload: Record<string, unknown>, key?: string) {
    const fingerprint = canonicalJson({ type, payload });
    const existing = key === undefined ? undefined : this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new EventConflictError("idempotency key conflicts with its original request");
      return { event: existing.event, replayed: true };
    }
    const event: EventRecord = { id: this.dependencies.nextId(), tenantId, type, payload, createdAt: this.dependencies.now() };
    this.repository.insert(event);
    if (key !== undefined) this.idempotency.set(key, { fingerprint, event });
    return { event, replayed: false };
  }

  get(tenantId: string, id: string): EventRecord | undefined {
    return this.repository.findById(tenantId, id);
  }

  list(tenantId: string): EventRecord[] {
    return this.repository.list(tenantId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
