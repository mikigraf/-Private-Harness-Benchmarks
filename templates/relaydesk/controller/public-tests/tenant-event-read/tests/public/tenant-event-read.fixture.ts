import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("tenant event reads", () => {
  it("allows the owner and hides the event from another tenant", async () => {
    let sequence = 0;
    const app = buildApp({ now: () => "2025-01-02T03:04:05.000Z", nextId: () => `evt-${++sequence}` });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/events", headers: { "x-tenant-id": "owner" }, payload: { type: "received", payload: { private: true } } });
    const id = created.json().event.id;
    const owner = await app.inject({ method: "GET", url: `/events/${id}`, headers: { "x-tenant-id": "owner" } });
    const foreign = await app.inject({ method: "GET", url: `/events/${id}`, headers: { "x-tenant-id": "other" } });
    const unknown = await app.inject({ method: "GET", url: "/events/missing", headers: { "x-tenant-id": "other" } });
    expect(owner.statusCode).toBe(200);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "not_found" });
    expect(unknown.json()).toEqual(foreign.json());
  });
});
