// Import order matters: capture.ts patches fetch before Fedify loads.
import "./capture.ts";
import "./logging.ts";
import { serve } from "@hono/node-server";
import { getLogger } from "@logtape/logtape";
import { ORIGIN, PORT } from "./config.ts";
import { migrate } from "./db.ts";
import { contextForBackground, federation } from "./federation.ts";
import "./inbox.ts";
import { migrateOutbox, runOutboxWorker } from "./outbox.ts";
import { app } from "./routes.ts";

const logger = getLogger(["feddit"]);

await migrate();
await migrateOutbox();

// Caddy terminates TLS and forwards plain HTTP. Rebase every request on the
// canonical origin so URLs Fedify derives from the request (custom collection
// ids, for one) say https://feddit.lab.test rather than http://.
const canonical = (request: Request) => {
  const url = new URL(request.url);
  return new Request(new URL(url.pathname + url.search, ORIGIN), request);
};

serve({ fetch: (request) => app.fetch(canonical(request)), port: PORT, hostname: "0.0.0.0" }, (info) => {
  logger.info("Listening on {port} as {origin}", { port: info.port, origin: ORIGIN.href });
});

// Both loops run until the process exits, so neither is awaited.
federation.startQueue(undefined).catch((error: unknown) => {
  logger.fatal("Inbox queue worker stopped: {error}", { error });
  process.exit(1);
});
runOutboxWorker(contextForBackground()).catch((error: unknown) => {
  logger.fatal("Outbox worker stopped: {error}", { error });
  process.exit(1);
});
