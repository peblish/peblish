// Fails when the Drizzle tables and the committed migrations disagree: runs drizzle-kit
// generate, and if it writes a migration, removes it again and exits 1.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dirname, '../drizzle');
const journal = join(out, 'meta/_journal.json');
const files = () => new Set([...readdirSync(out), ...readdirSync(join(out, 'meta')).map((file) => `meta/${file}`)]);

const before = files();
const journalBefore = readFileSync(journal, 'utf8');
const log = execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--name', 'drift_check'], {
  cwd: join(import.meta.dirname, '..'),
  encoding: 'utf8',
});
const added = [...files()].filter((file) => !before.has(file));

if (added.length === 0) {
  console.log('drift: none (drizzle-kit generate found no schema changes)');
} else {
  for (const file of added) rmSync(join(out, file));
  writeFileSync(journal, journalBefore);
  console.error(log);
  console.error(`drift: the tables differ from the migrations; drizzle-kit would add ${added.join(', ')}`);
  process.exit(1);
}
