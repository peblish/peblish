import { shutdown } from '@peblish/core/lifecycle';
import { definePlugin } from 'nitro';

// Nitro runs `close` after the HTTP server has stopped (SIGTERM or SIGINT). Closing core's
// pools there lets the process exit; idle database connections would otherwise keep it alive.
export default definePlugin((nitro) => {
  nitro.hooks.hook('close', shutdown);
});
