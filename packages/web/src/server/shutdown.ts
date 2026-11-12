import { shutdown } from '@peblish/core/lifecycle';
import { definePlugin } from 'nitro';
import { lineWritesUntilServerBuilt } from './shutdown-report.ts';

// Nitro runs `close` after the HTTP server has stopped (SIGTERM or SIGINT). Closing core's
// pools there lets the process exit; idle database connections would otherwise keep it alive.
// The server is built right after this plugin: its shutdown report is made line-based here.
export default definePlugin((nitro) => {
  lineWritesUntilServerBuilt();
  nitro.hooks.hook('close', shutdown);
});
