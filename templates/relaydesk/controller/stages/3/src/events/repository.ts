import type { EventRecord } from "./model.js";

export class MemoryEventRepository {
  private readonly events: EventRecord[] = [];

  insert(event: EventRecord): void {
    this.events.push(event);
  }

  findById(tenantId: string, id: string): EventRecord | undefined {
    return this.events.find((event) => event.tenantId === tenantId && event.id === id);
  }

  list(tenantId: string): EventRecord[] {
    return this.events.filter((event) => event.tenantId === tenantId);
  }
}
