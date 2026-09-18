import type { EventRecord } from "./model.js";

export interface EventCursor { tenantId: string; createdAt: string }

export function encodeCursor(event: EventRecord): string {
  return Buffer.from(JSON.stringify({ tenantId: event.tenantId, createdAt: event.createdAt }), "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): EventCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid cursor");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "createdAt,tenantId" || typeof (value as { createdAt?: unknown }).createdAt !== "string" || typeof (value as { tenantId?: unknown }).tenantId !== "string") {
    throw new Error("invalid cursor");
  }
  return value as EventCursor;
}

export function isAfterCursor(event: EventRecord, cursor: EventCursor): boolean {
  return event.createdAt > cursor.createdAt;
}
