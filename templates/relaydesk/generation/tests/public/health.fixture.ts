import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("public API", () => {
  it("reports health without fixture authentication", async () => {
    const app = buildApp({ now: () => "2025-01-02T03:04:05.000Z", nextId: () => "evt-public-000001" });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("requires a tenant and accepts a valid event", async () => {
    const app = buildApp({ now: () => "2025-01-02T03:04:05.000Z", nextId: () => "evt-public-000001" });
    apps.push(app);
    const unauthorized = await app.inject({ method: "POST", url: "/events", payload: { type: "ping", payload: {} } });
    expect(unauthorized.statusCode).toBe(401);
    const created = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "x-tenant-id": "tenant-public" },
      payload: { type: "ping", payload: { ok: true } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().event).toMatchObject({ id: "evt-public-000001", type: "ping", payload: { ok: true } });
    expect(created.json().event).not.toHaveProperty("tenantId");
  });
});
