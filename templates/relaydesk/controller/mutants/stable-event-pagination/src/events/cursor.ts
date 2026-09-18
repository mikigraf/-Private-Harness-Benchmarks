import type { EventRecord } from "./model.js";

export interface EventCursor { tenantId: string; createdAt: string; id: string }

export function encodeCursor(event: EventRecord): string {
  return Buffer.from(JSON.stringify({ tenantId: event.tenantId, createdAt: event.createdAt, id: event.id }), "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): EventCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid cursor");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "createdAt,id,tenantId") throw new Error("invalid cursor");
  const cursor = value as { tenantId?: unknown; createdAt?: unknown; id?: unknown };
  if (typeof cursor.tenantId !== "string" || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") throw new Error("invalid cursor");
  return cursor as EventCursor;
}

export function isAfterCursor(event: EventRecord, cursor: EventCursor): boolean {
  return event.createdAt > cursor.createdAt;
}
