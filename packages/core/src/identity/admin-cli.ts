// Creates the instance's first site admin. Run once after migrate, with the password on stdin:
//
//   printf '%s' "$ADMIN_PASSWORD" | DATABASE_URL=... node packages/core/src/identity/admin-cli.ts <name> <email>
//
// Refuses when an admin exists (admin.exists). Running it declares the admin 16 or older.
// Then sign in and turn on two-factor at /settings/security: admin actions need it.
import { text } from 'node:stream/consumers';
import { closePools } from '../db/pools.ts';
import { bootstrapAdmin } from './bootstrap.ts';

const [name, email] = process.argv.slice(2);
if (!name || !email) {
  console.error('usage: node packages/core/src/identity/admin-cli.ts <name> <email>  (password on stdin)');
  process.exit(64);
}
try {
  const password = (await text(process.stdin)).replace(/\r?\n$/, '');
  const result = await bootstrapAdmin({ name, email, password });
  if (!result.ok) {
    console.error(`admin not created: ${result.reason}`);
    process.exitCode = 1;
  } else console.log(`admin ${name} created (actor ${result.actorId})`);
} finally {
  await closePools();
}
