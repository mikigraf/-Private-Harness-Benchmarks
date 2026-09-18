---
name: tenant-safety
description: Review tenant context and data access boundaries when changing reads, writes, identity propagation, or returned records in a multi-tenant service.
---

Trace the caller's tenant from the authentication adapter through the service and repository to the response. Identify where caller-controlled identifiers meet stored data. Preserve legitimate owner behavior while preventing cross-tenant access or mutation.

Exercise both allowed and forbidden behavior where feasible. Avoid returning sensitive record details in error responses or logs. Do not introduce credentials or assume the local fixture authentication mechanism is suitable for production.
