import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RelayDeskStage = 0 | 1 | 2 | 3;

export interface FileEntry {
  path: string;
  content: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface SeedTask {
  id: string;
  title: string;
  body: string;
  risk: "CRITICAL" | "STANDARD";
  component: string;
}

export interface RelayDeskCheck {
  id: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

export const seedTasks: readonly SeedTask[] = [
  {
    id: "tenant-event-read",
    title: "Scope event reads to the authenticated tenant",
    body: "An authenticated tenant must not retrieve another tenant's event by ID. A legitimate owner's lookup must continue to work. Return the same 404 error for foreign and unknown IDs.",
    risk: "CRITICAL",
    component: "tenant isolation",
  },
  {
    id: "tenant-idempotency",
    title: "Make event idempotency tenant scoped",
    body: "Repeated delivery with the same tenant and idempotency key must not create duplicates. Preserve the original response identity. Conflicting reuse returns 409. Different tenants can reuse the same key independently.",
    risk: "CRITICAL",
    component: "data integrity",
  },
  {
    id: "stable-event-pagination",
    title: "Paginate events with a stable complete ordering key",
    body: "Paginate a tenant's events in ascending creation time with ID tie-breaking. A traversal must return each event exactly once, including events sharing a timestamp. Reject invalid cursor and limit inputs.",
    risk: "STANDARD",
    component: "pagination",
  },
];

const taskStage = new Map(
  seedTasks.map((task, index) => [task.id, index as RelayDeskStage]),
);

/** Build a complete candidate-visible fixture. Controller files are never included. */
export async function materializeFixture(
  stage: RelayDeskStage,
): Promise<FileEntry[]> {
  assertStage(stage);
  const root = await relayDeskTemplateRoot();
  const files = new Map<string, Buffer>();
  for (const [path, content] of await readTree(resolve(root, "generation")))
    files.set(candidatePath(path), content);
  for (const [path, content] of await readTree(
    resolve(root, "controller/common"),
  ))
    files.set(path, content);
  for (const [path, content] of await readTree(
    resolve(root, `controller/stages/${stage}`),
  ))
    files.set(path, content);
  for (const task of seedTasks.slice(0, stage)) {
    for (const [path, content] of await readTree(
      resolve(root, `controller/public-tests/${task.id}`),
    ))
      files.set(candidatePath(path), content);
  }
  return entries(files);
}

/** Return the complete application source at the accepted stage after a task. */
export async function referenceFiles(taskId: string): Promise<FileEntry[]> {
  const base = requiredTaskStage(taskId);
  return sourceManifest((base + 1) as RelayDeskStage);
}

/** Return a complete source tree containing a plausible but behaviorally wrong solution. */
export async function mutantFiles(taskId: string): Promise<FileEntry[]> {
  const base = requiredTaskStage(taskId);
  const root = await relayDeskTemplateRoot();
  const files = await sourceBuffers((base + 1) as RelayDeskStage);
  for (const [path, content] of await readTree(
    resolve(root, `controller/mutants/${taskId}`),
  ))
    files.set(path, content);
  return entries(files);
}

async function sourceManifest(stage: RelayDeskStage): Promise<FileEntry[]> {
  return entries(await sourceBuffers(stage));
}

async function sourceBuffers(
  stage: RelayDeskStage,
): Promise<Map<string, Buffer>> {
  assertStage(stage);
  const root = await relayDeskTemplateRoot();
  const files = new Map<string, Buffer>();
  for (const [path, content] of await readTree(
    resolve(root, "controller/common"),
  ))
    files.set(path, content);
  for (const [path, content] of await readTree(
    resolve(root, `controller/stages/${stage}`),
  ))
    files.set(path, content);
  return files;
}

function entries(files: Map<string, Buffer>): FileEntry[] {
  return [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => ({
      path,
      content: bytes.toString("base64"),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: 0o100644,
    }));
}

function candidatePath(path: string): string {
  return path.replace(/\.fixture\.ts$/, ".test.ts");
}

async function readTree(
  root: string,
  relative = "",
): Promise<Array<[string, Buffer]>> {
  const directory = resolve(root, relative);
  const children = await readdir(directory, { withFileTypes: true });
  const files: Array<[string, Buffer]> = [];
  for (const child of children.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (child.isSymbolicLink())
      throw new Error(
        `RelayDesk template contains a symbolic link: ${child.name}`,
      );
    const childRelative = relative
      ? posix.join(relative, child.name)
      : child.name;
    if (child.isDirectory())
      files.push(...(await readTree(root, childRelative)));
    else if (child.isFile())
      files.push([childRelative, await readFile(resolve(root, childRelative))]);
    else
      throw new Error(
        `RelayDesk template contains an unsupported entry: ${childRelative}`,
      );
  }
  return files;
}

let resolvedTemplateRoot: string | undefined;
async function relayDeskTemplateRoot(): Promise<string> {
  if (resolvedTemplateRoot) return resolvedTemplateRoot;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "templates/relaydesk"),
    resolve(moduleDirectory, "../../templates/relaydesk"),
    resolve(moduleDirectory, "../../../templates/relaydesk"),
  ];
  for (const candidate of candidates) {
    try {
      if (
        (await stat(resolve(candidate, "generation/package.json"))).isFile()
      ) {
        resolvedTemplateRoot = candidate;
        return candidate;
      }
    } catch {
      // Try the next source/build layout.
    }
  }
  throw new Error("Could not locate templates/relaydesk");
}

function assertStage(stage: number): asserts stage is RelayDeskStage {
  if (![0, 1, 2, 3].includes(stage))
    throw new Error(`Invalid RelayDesk stage: ${stage}`);
}

function requiredTaskStage(taskId: string): RelayDeskStage {
  const stage = taskStage.get(taskId);
  if (stage === undefined) throw new Error(`Unknown RelayDesk task: ${taskId}`);
  return stage;
}

const checkIds: Record<string, readonly string[]> = {
  "tenant-event-read": [
    "tenant-read.foreign-is-404",
    "tenant-read.foreign-body-redacted",
    "tenant-read.owner-is-200",
    "tenant-read.unknown-is-404",
    "tenant-read.independent-owner",
    "common.health",
  ],
  "tenant-idempotency": [
    "idempotency.same-request-one-row",
    "idempotency.replay-stable-response",
    "idempotency.conflict-is-409",
    "idempotency.tenant-scoped-key",
    "idempotency.keyless-independent",
    "idempotency.object-order-equivalent",
    "idempotency.array-order-significant",
    "tenant-read.foreign-is-404",
  ],
  "stable-event-pagination": [
    "pagination.tie-no-omission",
    "pagination.no-duplicates",
    "pagination.stable-order",
    "pagination.final-cursor-null",
    "pagination.empty",
    "pagination.invalid-input-400",
    "pagination.tenant-isolation",
    "idempotency.same-request-one-row",
  ],
};

export function expectedCheckIds(taskId: string): string[] {
  const ids = checkIds[taskId];
  if (!ids) throw new Error(`Unknown RelayDesk task: ${taskId}`);
  return [...ids];
}

class CandidateBehaviorError extends Error {
  override readonly name = "CandidateBehaviorError";
}

/** Run protected black-box checks using only the candidate's HTTP surface. */
export async function verifyRelayDesk(
  taskId: string,
  baseUrl: string,
): Promise<RelayDeskCheck[]> {
  const ids = checkIds[taskId];
  if (!ids) throw new Error(`Unknown RelayDesk task: ${taskId}`);
  try {
    if (taskId === "tenant-event-read") return await verifyTenantRead(baseUrl);
    if (taskId === "tenant-idempotency")
      return await verifyIdempotency(baseUrl);
    return await verifyPagination(baseUrl);
  } catch (error) {
    if (!(error instanceof CandidateBehaviorError)) throw error;
    const detail = `Verifier setup failed: ${error instanceof Error ? error.message : String(error)}`;
    return ids.map((id) => ({ id, status: "FAIL", detail }));
  }
}

interface HttpResult {
  status: number;
  body: unknown;
}
interface VisibleEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

async function verifyTenantRead(baseUrl: string): Promise<RelayDeskCheck[]> {
  const owner = "verify-read-owner";
  const other = "verify-read-other";
  const ownerCreated = await createEvent(baseUrl, owner, "owner.event", {
    secret: "owner-only",
    zero: 0,
  });
  const otherCreated = await createEvent(baseUrl, other, "other.event", {
    independent: true,
  });
  const ownerEvent = eventFrom(ownerCreated);
  const otherEvent = eventFrom(otherCreated);
  const foreign = await request(
    baseUrl,
    `/events/${encodeURIComponent(ownerEvent.id)}`,
    { tenant: other },
  );
  const ownerRead = await request(
    baseUrl,
    `/events/${encodeURIComponent(ownerEvent.id)}`,
    { tenant: owner },
  );
  const unknown = await request(baseUrl, "/events/definitely-unknown", {
    tenant: other,
  });
  const otherRead = await request(
    baseUrl,
    `/events/${encodeURIComponent(otherEvent.id)}`,
    { tenant: other },
  );
  const health = await request(baseUrl, "/health");

  return [
    check(
      "tenant-read.foreign-is-404",
      foreign.status === 404,
      `foreign read returned ${foreign.status}`,
    ),
    check(
      "tenant-read.foreign-body-redacted",
      foreign.status === 404 &&
        redactedNotFound(foreign.body, owner, ownerEvent),
      "foreign response exposed event data or had the wrong error shape",
    ),
    check(
      "tenant-read.owner-is-200",
      ownerRead.status === 200 && equal(eventBody(ownerRead), ownerEvent),
      `owner read returned ${ownerRead.status} or changed the event`,
    ),
    check(
      "tenant-read.unknown-is-404",
      unknown.status === foreign.status && equal(unknown.body, foreign.body),
      "unknown and foreign reads differed",
    ),
    check(
      "tenant-read.independent-owner",
      otherRead.status === 200 && equal(eventBody(otherRead), otherEvent),
      "the second tenant could not read its own event",
    ),
    check(
      "common.health",
      health.status === 200 && equal(health.body, { ok: true }),
      `health returned ${health.status} or an unexpected body`,
    ),
  ];
}

async function verifyIdempotency(baseUrl: string): Promise<RelayDeskCheck[]> {
  const tenantA = "verify-idem-a";
  const tenantB = "verify-idem-b";
  const headers = { tenant: tenantA, key: "delivery-main" };
  const originalBody = {
    type: "delivery.main",
    payload: { nested: { b: 2, a: 1 }, active: false },
  };
  const first = await request(baseUrl, "/events", {
    method: "POST",
    ...headers,
    body: originalBody,
  });
  const replay = await request(baseUrl, "/events", {
    method: "POST",
    ...headers,
    body: originalBody,
  });
  const conflict = await request(baseUrl, "/events", {
    method: "POST",
    ...headers,
    body: { type: "delivery.changed", payload: { nested: { a: 1, b: 2 } } },
  });
  const tenantBCreate = await request(baseUrl, "/events", {
    method: "POST",
    tenant: tenantB,
    key: "delivery-main",
    body: originalBody,
  });

  const keylessOne = await createEvent(baseUrl, tenantA, "delivery.keyless", {
    attempt: 0,
  });
  const keylessTwo = await createEvent(baseUrl, tenantA, "delivery.keyless", {
    attempt: 0,
  });
  const objectFirst = await request(baseUrl, "/events", {
    method: "POST",
    tenant: tenantA,
    key: "object-order",
    body: { type: "delivery.object", payload: { a: 1, b: { x: 2, y: 3 } } },
  });
  const objectReplay = await request(baseUrl, "/events", {
    method: "POST",
    tenant: tenantA,
    key: "object-order",
    body: { type: "delivery.object", payload: { b: { y: 3, x: 2 }, a: 1 } },
  });
  const arrayFirst = await request(baseUrl, "/events", {
    method: "POST",
    tenant: tenantA,
    key: "array-order",
    body: { type: "delivery.array", payload: { values: [1, 2, 3] } },
  });
  const arrayConflict = await request(baseUrl, "/events", {
    method: "POST",
    tenant: tenantA,
    key: "array-order",
    body: { type: "delivery.array", payload: { values: [3, 2, 1] } },
  });
  const listA = await listEvents(baseUrl, tenantA, 100);
  const listB = await listEvents(baseUrl, tenantB, 100);
  const eventsA = listBody(listA);
  const eventsB = listBody(listB);
  const firstEvent = eventFrom(first);
  const foreign = await request(
    baseUrl,
    `/events/${encodeURIComponent(firstEvent.id)}`,
    { tenant: tenantB },
  );

  return [
    check(
      "idempotency.same-request-one-row",
      eventsA.filter((event) => event.type === "delivery.main").length === 1,
      "identical requests did not produce exactly one visible row",
    ),
    check(
      "idempotency.replay-stable-response",
      first.status === 201 &&
        replay.status === 200 &&
        equal(first.body, replay.body),
      "replay did not preserve the original response with status 200",
    ),
    check(
      "idempotency.conflict-is-409",
      conflict.status === 409 &&
        eventsA.every((event) => event.type !== "delivery.changed"),
      "conflicting reuse did not return 409 without a write",
    ),
    check(
      "idempotency.tenant-scoped-key",
      tenantBCreate.status === 201 &&
        eventsB.length === 1 &&
        eventFrom(tenantBCreate).id !== firstEvent.id,
      "another tenant could not independently use the same key",
    ),
    check(
      "idempotency.keyless-independent",
      keylessOne.status === 201 &&
        keylessTwo.status === 201 &&
        eventFrom(keylessOne).id !== eventFrom(keylessTwo).id &&
        eventsA.filter((event) => event.type === "delivery.keyless").length ===
          2,
      "keyless requests were not independent creations",
    ),
    check(
      "idempotency.object-order-equivalent",
      objectFirst.status === 201 &&
        objectReplay.status === 200 &&
        eventFrom(objectFirst).id === eventFrom(objectReplay).id,
      "object key insertion order changed idempotency meaning",
    ),
    check(
      "idempotency.array-order-significant",
      arrayFirst.status === 201 && arrayConflict.status === 409,
      "array reordering was not treated as a conflicting payload",
    ),
    check(
      "tenant-read.foreign-is-404",
      foreign.status === 404,
      `foreign read returned ${foreign.status}`,
    ),
  ];
}

async function verifyPagination(baseUrl: string): Promise<RelayDeskCheck[]> {
  const tenant = "verify-pages-main";
  const foreignTenant = "verify-pages-foreign";
  const created: VisibleEvent[] = [];
  for (let index = 0; index < 5; index += 1) {
    if (index === 2)
      await createEvent(baseUrl, foreignTenant, "foreign.page", { index });
    created.push(
      eventFrom(await createEvent(baseUrl, tenant, "page.item", { index })),
    );
  }
  await createEvent(baseUrl, foreignTenant, "foreign.page", { index: 5 });
  await createEvent(baseUrl, foreignTenant, "foreign.page", { index: 6 });
  const traversal = await traverse(baseUrl, tenant, 2);
  const observedIds = traversal.events.map((event) => event.id);
  const expectedIds = [...created].sort(compareEvents).map((event) => event.id);

  const exactTenant = "verify-pages-exact";
  for (let index = 0; index < 4; index += 1)
    await createEvent(baseUrl, exactTenant, "exact.item", { index });
  const exactTraversal = await traverse(baseUrl, exactTenant, 2);
  const empty = await listEvents(baseUrl, "verify-pages-empty", 3);
  const invalidUrls = [
    "/events?limit=0",
    "/events?limit=-1",
    "/events?limit=101",
    "/events?limit=1.5",
    "/events?limit=nope",
    "/events?limit=2&cursor=%25%25%25bad",
  ];
  const invalid = await Promise.all(
    invalidUrls.map((path) => request(baseUrl, path, { tenant })),
  );
  const foreignPage = await listEvents(baseUrl, foreignTenant, 2);
  const foreignCursor = (foreignPage.body as { nextCursor?: unknown })
    ?.nextCursor;
  const crossedCursor =
    typeof foreignCursor === "string"
      ? await listEvents(baseUrl, tenant, 2, foreignCursor)
      : { status: 500, body: null };

  const idemTenant = "verify-pages-idem";
  const idemBody = { type: "idem.page", payload: { ok: true } };
  const idemFirst = await request(baseUrl, "/events", {
    method: "POST",
    tenant: idemTenant,
    key: "same",
    body: idemBody,
  });
  const idemReplay = await request(baseUrl, "/events", {
    method: "POST",
    tenant: idemTenant,
    key: "same",
    body: idemBody,
  });
  const idemList = await listEvents(baseUrl, idemTenant, 10);

  return [
    check(
      "pagination.tie-no-omission",
      equal(observedIds, expectedIds),
      `expected ${expectedIds.length} tied events, observed ${observedIds.length}`,
    ),
    check(
      "pagination.no-duplicates",
      new Set(observedIds).size === observedIds.length,
      "traversal returned an event ID more than once",
    ),
    check(
      "pagination.stable-order",
      traversal.events.every(
        (event, index, all) =>
          index === 0 || compareEvents(all[index - 1]!, event) < 0,
      ),
      "events were not strictly ordered by createdAt and ID",
    ),
    check(
      "pagination.final-cursor-null",
      exactTraversal.events.length === 4 &&
        exactTraversal.pageCount === 2 &&
        exactTraversal.finalCursor === null,
      "an exact page multiple did not end on its last populated page with a null cursor",
    ),
    check(
      "pagination.empty",
      empty.status === 200 &&
        equal(empty.body, { events: [], nextCursor: null }),
      "empty tenant did not return an empty terminal page",
    ),
    check(
      "pagination.invalid-input-400",
      invalid.every((response) => response.status === 400),
      `invalid inputs returned statuses ${invalid.map((response) => response.status).join(",")}`,
    ),
    check(
      "pagination.tenant-isolation",
      traversal.events.every((event) => event.type === "page.item") &&
        crossedCursor.status === 400,
      "foreign events appeared or a cursor crossed tenant scope",
    ),
    check(
      "idempotency.same-request-one-row",
      idemFirst.status === 201 &&
        idemReplay.status === 200 &&
        listBody(idemList).filter((event) => event.type === "idem.page")
          .length === 1,
      "previous idempotency behavior regressed",
    ),
  ];
}

interface RequestOptions {
  method?: "GET" | "POST";
  tenant?: string;
  key?: string;
  body?: unknown;
}

async function request(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (options.tenant) headers["X-Tenant-Id"] = options.tenant;
  if (options.key) headers["Idempotency-Key"] = options.key;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const url = new URL(path, withTrailingSlash(baseUrl));
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    text = await response.text();
  } catch (error) {
    throw new CandidateBehaviorError(
      `candidate HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function createEvent(
  baseUrl: string,
  tenant: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<HttpResult> {
  return request(baseUrl, "/events", {
    method: "POST",
    tenant,
    body: { type, payload },
  });
}

async function listEvents(
  baseUrl: string,
  tenant: string,
  limit: number,
  cursor?: string,
): Promise<HttpResult> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) query.set("cursor", cursor);
  return request(baseUrl, `/events?${query}`, { tenant });
}

async function traverse(
  baseUrl: string,
  tenant: string,
  limit: number,
): Promise<{
  events: VisibleEvent[];
  pageCount: number;
  finalCursor: string | null;
}> {
  const events: VisibleEvent[] = [];
  let cursor: string | undefined;
  let finalCursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let pageCount = 1; pageCount <= 20; pageCount += 1) {
    const response = await listEvents(baseUrl, tenant, limit, cursor);
    if (response.status !== 200)
      throw new CandidateBehaviorError(
        `pagination returned ${response.status}`,
      );
    const body = response.body as { events?: unknown; nextCursor?: unknown };
    if (
      !Array.isArray(body?.events) ||
      !(body.nextCursor === null || typeof body.nextCursor === "string")
    )
      throw new CandidateBehaviorError("pagination response shape was invalid");
    events.push(...body.events.map(asEvent));
    finalCursor = body.nextCursor;
    if (finalCursor === null) return { events, pageCount, finalCursor };
    if (seenCursors.has(finalCursor))
      throw new CandidateBehaviorError("pagination cursor repeated");
    seenCursors.add(finalCursor);
    cursor = finalCursor;
  }
  throw new CandidateBehaviorError("pagination did not terminate");
}

function eventFrom(response: HttpResult): VisibleEvent {
  if (response.status !== 200 && response.status !== 201)
    throw new CandidateBehaviorError(
      `event request returned ${response.status}`,
    );
  return asEvent(eventBody(response));
}

function eventBody(response: HttpResult): unknown {
  return response.body && typeof response.body === "object"
    ? (response.body as { event?: unknown }).event
    : undefined;
}

function asEvent(value: unknown): VisibleEvent {
  if (!value || typeof value !== "object")
    throw new CandidateBehaviorError("event response was missing an event");
  const event = value as Partial<VisibleEvent>;
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.createdAt !== "string" ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new CandidateBehaviorError("event response had an invalid shape");
  }
  return event as VisibleEvent;
}

function listBody(response: HttpResult): VisibleEvent[] {
  if (
    response.status !== 200 ||
    !response.body ||
    typeof response.body !== "object" ||
    !Array.isArray((response.body as { events?: unknown }).events)
  ) {
    throw new CandidateBehaviorError(
      `list request returned ${response.status} or an invalid shape`,
    );
  }
  return (response.body as { events: unknown[] }).events.map(asEvent);
}

function redactedNotFound(
  body: unknown,
  tenant: string,
  event: VisibleEvent,
): boolean {
  if (!equal(body, { error: "not_found" })) return false;
  const serialized = JSON.stringify(body);
  return (
    !serialized.includes(tenant) &&
    !serialized.includes(event.id) &&
    !serialized.includes("owner-only") &&
    !serialized.includes("payload")
  );
}

function compareEvents(left: VisibleEvent, right: VisibleEvent): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(id: string, passed: boolean, failure: string): RelayDeskCheck {
  return passed
    ? { id, status: "PASS", detail: "Observed expected HTTP behavior." }
    : { id, status: "FAIL", detail: failure };
}
