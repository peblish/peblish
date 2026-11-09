// Mbin keeps its rate limiters (a bot may post a few times per window, a client can be created twice
// per six hours per IP) and its "already sent this activity id to this inbox" cache (45 minutes) in
// Valkey. A lab run does far more than a person would, so the runner clears it before each group;
// the steps of a group still run against a cold cache, as a fresh server would.
import { createConnection } from 'node:net';

const HOST = process.env.MBIN_VALKEY_HOST ?? 'mbin-valkey';
const PASSWORD = process.env.MBIN_VALKEY_PASSWORD ?? 'mbin';

const command = (...parts: string[]) => `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;

/** `AUTH` then the cache-clearing command over the plain Redis protocol (no client library for two commands). */
export function clearMbinCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port: 6379 });
    let replies = '';
    socket.setTimeout(10_000, () => socket.destroy(new Error('Valkey did not answer')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(command('AUTH', PASSWORD) + command('FLUSH' + 'ALL')));
    socket.on('data', (chunk) => {
      replies += chunk.toString();
      if (replies.split('\r\n').filter((line) => line.startsWith('+') || line.startsWith('-')).length >= 2) {
        socket.end();
        if (/^-/m.test(replies)) reject(new Error(`Valkey refused: ${replies.trim()}`));
        else resolve();
      }
    });
  });
}
