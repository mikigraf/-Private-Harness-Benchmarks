import type { EventRecord } from "./model.js";

export class MemoryEventRepository {
  private readonly events: EventRecord[] = [];

  insert(event: EventRecord): void {
    this.events.push(event);
  }

  findById(_tenantId: string, _id: string): EventRecord | undefined {
    return undefined;
  }

  list(tenantId: string): EventRecord[] {
    return this.events.filter((event) => event.tenantId === tenantId);
  }
}
