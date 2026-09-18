import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("tenant idempotency", () => {
  it("replays within a tenant, rejects conflicts, and scopes a key by tenant", async () => {
    let sequence = 0;
    const app = buildApp({ now: () => "2025-01-02T03:04:05.000Z", nextId: () => `evt-${++sequence}` });
    apps.push(app);
    const headers = { "x-tenant-id": "tenant-a", "idempotency-key": "delivery-1" };
    const payload = { type: "received", payload: { nested: { a: 1, b: 2 } } };
    const first = await app.inject({ method: "POST", url: "/events", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/events", headers, payload: { type: "received", payload: { nested: { b: 2, a: 1 } } } });
    const conflict = await app.inject({ method: "POST", url: "/events", headers, payload: { type: "changed", payload: {} } });
    const other = await app.inject({ method: "POST", url: "/events", headers: { ...headers, "x-tenant-id": "tenant-b" }, payload });
    const list = await app.inject({ method: "GET", url: "/events?limit=100", headers: { "x-tenant-id": "tenant-a" } });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(other.statusCode).toBe(201);
    expect(list.json().events).toHaveLength(1);
  });
});
