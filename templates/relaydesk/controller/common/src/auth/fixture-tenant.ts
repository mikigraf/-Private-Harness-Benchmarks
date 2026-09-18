import type { FastifyRequest } from "fastify";

export function fixtureTenant(request: FastifyRequest): string | undefined {
  const value = request.headers["x-tenant-id"];
  if (typeof value !== "string") return undefined;
  const tenantId = value.trim();
  return tenantId.length > 0 ? tenantId : undefined;
}
