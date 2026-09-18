import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("stable event pagination", () => {
  it("traverses tied timestamps once in ID order and rejects invalid input", async () => {
    let sequence = 0;
    const app = buildApp({ now: () => "2025-01-02T03:04:05.000Z", nextId: () => `evt-${String(++sequence).padStart(4, "0")}` });
    apps.push(app);
    const headers = { "x-tenant-id": "tenant-pages" };
    for (let index = 0; index < 5; index += 1) {
      await app.inject({ method: "POST", url: "/events", headers, payload: { type: "received", payload: { index } } });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page = await app.inject({ method: "GET", url: `/events${query}`, headers });
      expect(page.statusCode).toBe(200);
      ids.push(...page.json().events.map((event: { id: string }) => event.id));
      cursor = page.json().nextCursor;
    } while (cursor);
    expect(ids).toEqual(["evt-0001", "evt-0002", "evt-0003", "evt-0004", "evt-0005"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=%25%25bad"]) {
      expect((await app.inject({ method: "GET", url: `/events?${query}`, headers })).statusCode).toBe(400);
    }
  });
});
