export interface EventRecord {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type PublicEvent = Omit<EventRecord, "tenantId">;

export function publicEvent(event: EventRecord): PublicEvent {
  const { tenantId: _tenantId, ...visible } = event;
  return visible;
}
