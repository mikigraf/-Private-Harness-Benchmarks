import { verifyRelayDesk } from "./relaydesk.js";
const task = process.env.FULLBEAM_TASK_ID;
const url = process.env.TARGET_URL;
if (!task || !url) throw new Error("Missing trusted verifier configuration");
const checks = await verifyRelayDesk(task, url);
process.stdout.write(JSON.stringify({ checks }));
