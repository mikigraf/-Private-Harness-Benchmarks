import type { AppDependencies } from "../app.js";
import type { EventRecord } from "./model.js";
import { MemoryEventRepository } from "./repository.js";

export class EventConflictError extends Error {}

export class EventService {
  constructor(private readonly repository: MemoryEventRepository, private readonly dependencies: AppDependencies) {}

  create(tenantId: string, type: string, payload: Record<string, unknown>, _key?: string) {
    const event: EventRecord = { id: this.dependencies.nextId(), tenantId, type, payload, createdAt: this.dependencies.now() };
    this.repository.insert(event);
    return { event, replayed: false };
  }

  get(tenantId: string, id: string): EventRecord | undefined {
    return this.repository.findById(tenantId, id);
  }

  list(tenantId: string): EventRecord[] {
    return this.repository.list(tenantId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}
