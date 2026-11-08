import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { getFileSink } from "@logtape/file";
import {
  configure,
  getConsoleSink,
  getLevelFilter,
  jsonLinesFormatter,
  type LogRecord,
  withFilter,
} from "@logtape/logtape";
import { CAPTURE_DIR } from "./config.ts";

// Request lines for the /spike control surface (polled every second by the
// scenarios) are noise; federation traffic is what the captures are for.
const notControlSurface = (record: LogRecord) => !JSON.stringify(record.properties).includes("/spike/");

// Console gets info and up; captures/fedify.jsonl gets Fedify's debug stream
// (signature decisions, inbox routing, queue retries) for later analysis.
await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: withFilter(withFilter(getConsoleSink(), getLevelFilter("info")), notControlSurface),
    file: withFilter(
      getFileSink(join(CAPTURE_DIR, "fedify.jsonl"), { formatter: jsonLinesFormatter }),
      notControlSurface,
    ),
  },
  loggers: [
    { category: "fedify", lowestLevel: "debug", sinks: ["console", "file"] },
    { category: "feddit", lowestLevel: "debug", sinks: ["console", "file"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
  ],
});
