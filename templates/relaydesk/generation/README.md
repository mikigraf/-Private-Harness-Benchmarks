# RelayDesk fixture

RelayDesk is a small in-memory webhook inbox used for an isolated engineering exercise. `X-Tenant-Id` is required on business endpoints and is fixture authentication only; it is not a secure production identity mechanism.

Use Node 24. Run `npm ci`, `npm run build`, `npm test`, and `npm start`. The server binds to `PORT` and exposes unauthenticated `GET /health`.
