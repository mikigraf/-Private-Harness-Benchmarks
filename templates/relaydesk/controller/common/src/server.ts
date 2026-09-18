import { buildApp } from "./app.js";

const fixedTime = process.env.RELAYDESK_FIXED_TIME;
const idPrefix = process.env.RELAYDESK_ID_PREFIX ?? "evt-";
let sequence = 0;
const app = buildApp({
  now: fixedTime ? () => fixedTime : () => new Date().toISOString(),
  nextId: () => `${idPrefix}${String(++sequence).padStart(8, "0")}`,
});

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");

await app.listen({ host: "0.0.0.0", port });

const close = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
