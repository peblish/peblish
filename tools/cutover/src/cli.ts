import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { closePools } from '@peblish/core/db/pools';
import { crossCheckKeyFiles, exportBundle, inventory } from './archive.ts';
import { readBundle, rehostBundle, writeBundle } from './bundle.ts';
import { backup, dropDatabase, exportLedger, reapplyLedger, readLedgerExport, restore, tableCounts } from './drill.ts';
import { importBundle } from './import.ts';
import { verifyImport } from './verify.ts';

// The cutover tool (deploy/cutover.md has the runbook):
//
//   node tools/cutover/src/cli.ts inventory --archive-db <url>
//   node tools/cutover/src/cli.ts export --archive-db <url> --out <file> [--admin <name>]... [--archive-dir <dir>] [--replace]
//   node tools/cutover/src/cli.ts import --bundle <file> [--rehearsal-host <host>]        (DATABASE_URL, PUBLIC_ORIGIN)
//   node tools/cutover/src/cli.ts verify [--bundle <file> [--rehearsal-host <host>]] [--json] (DATABASE_URL)
//   node tools/cutover/src/cli.ts backup --db <url> --out <file>
//   node tools/cutover/src/cli.ts ledger-export --db <url> --out <file>
//   node tools/cutover/src/cli.ts restore --backup <file> --db <new database url> [--ledger <file>]
//   node tools/cutover/src/cli.ts drill --db <url> --dir <scratch folder> [--keep]
//
// The bundle, backups and ledger exports are written with mode 600 and never inside the
// repository. Nothing prints key material, email addresses or password hashes.

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'archive-db': { type: 'string' },
    'archive-dir': { type: 'string' },
    out: { type: 'string' },
    admin: { type: 'string', multiple: true },
    replace: { type: 'boolean' },
    bundle: { type: 'string' },
    'rehearsal-host': { type: 'string' },
    json: { type: 'boolean' },
    db: { type: 'string' },
    backup: { type: 'string' },
    ledger: { type: 'string' },
    dir: { type: 'string' },
    keep: { type: 'boolean' },
  },
});

function need(name: keyof typeof values | 'DATABASE_URL' | 'PUBLIC_ORIGIN'): string {
  const value = name === 'DATABASE_URL' || name === 'PUBLIC_ORIGIN' ? process.env[name] : values[name];
  if (typeof value !== 'string' || value === '')
    throw new Usage(`${name === 'DATABASE_URL' || name === 'PUBLIC_ORIGIN' ? name : `--${name}`} is required`);
  return value;
}

class Usage extends Error {}

const archiveDb = () => values['archive-db'] ?? process.env.CUTOVER_ARCHIVE_DB_URL ?? need('archive-db');
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main(): Promise<number> {
  const [command] = positionals;
  switch (command) {
    case 'inventory': {
      const report = await inventory(archiveDb());
      if (values.json) print(report);
      else {
        console.log(`${report.origin} (PieFed schema ${report.schema})`);
        console.log(`local users: ${report.localUsers.join(', ')}; local communities: ${report.localCommunities.join(', ')}`);
        for (const m of report.members) {
          console.log(
            `${m.community}: ${m.local.length + m.remote} members, local ${m.local.length} (${m.local.join(', ') || 'none'}), remote ${m.remote}${m.localOnly ? '; local only' : ''}`,
          );
        }
        console.log(
          `chat messages ${report.chatMessages}, conversations ${report.conversations}, local posts ${report.localPosts}, local comments ${report.localComments}`,
        );
        for (const f of report.follows) {
          console.log(
            `${f.user} follows ${f.total} (PieFed memberships): ${f.toRemote} remote on ${f.instances} instances, ${f.toLocal} local; with a Follow id ${f.withFollowId}, join requests never accepted ${f.pendingOnly}, banned ${f.banned}, on instances PieFed marks dormant ${f.onDormantInstances}; by software ${
              Object.entries(f.bySoftware)
                .map(([s, n]) => `${s} ${n}`)
                .join(', ') || 'none'
            }`,
          );
        }
      }
      return 0;
    }
    case 'export': {
      const bundle = await exportBundle(archiveDb(), { admins: values.admin ?? [] });
      if (values['archive-dir']) {
        const { checked, problems } = crossCheckKeyFiles(bundle, values['archive-dir']);
        if (problems.length > 0) {
          console.error(`the key files disagree with the database:\n${problems.join('\n')}`);
          return 1;
        }
        console.log(`key files: ${checked} key pairs match the database`);
      }
      writeBundle(need('out'), bundle, values.replace === true);
      console.log(
        `bundle written (mode 600): instance actor, ${bundle.users.length} users (admins: ${
          bundle.users
            .filter((u) => u.role === 'admin')
            .map((u) => u.name)
            .join(', ') || 'none'
        }), ${bundle.communities.length} communities, ${bundle.remoteCommunities.length} remote communities, ${bundle.follows.length} follows`,
      );
      return 0;
    }
    case 'import': {
      const report = await importBundle(readBundle(need('bundle')), {
        publicOrigin: need('PUBLIC_ORIGIN'),
        ...(values['rehearsal-host'] ? { rehearsalHost: values['rehearsal-host'] } : {}),
      });
      print(report);
      return 0;
    }
    case 'verify': {
      const loaded = values.bundle ? readBundle(values.bundle) : null;
      const host = values['rehearsal-host'];
      const report = await verifyImport(loaded && host ? rehostBundle(loaded, `https://${host}`) : loaded);
      if (values.json) print(report);
      else {
        console.log(`${report.origin}`);
        for (const k of report.keys) {
          const flags = [
            `pair ${k.pair}`,
            `signature ${k.signature}`,
            `served ${k.served}`,
            `routed ${k.routed}`,
            `bundle ${k.matchesBundle ?? 'n/a'}`,
          ];
          console.log(`${k.kind} ${k.apId} ${k.keyId} sha256:${k.fingerprint}: ${flags.join(', ')}`);
        }
        for (const f of report.follows) {
          console.log(
            `${f.follower} -> ${f.followee} ${f.state} ${f.local ? 'local' : `${f.software ?? 'unknown'} inbox ${f.inbox ?? 'none'}${f.deliverable ? '' : ' (held)'}`}`,
          );
        }
        print(report.summary);
      }
      const ok = report.keys.every((k) => k.pair && k.signature && k.served && k.matchesBundle !== false);
      return ok ? 0 : 1;
    }
    case 'backup':
      await backup(need('db'), need('out'));
      console.log('backup written (mode 600)');
      return 0;
    case 'ledger-export':
      console.log(`ledger export written (mode 600): ${await exportLedger(need('db'), need('out'))} rows`);
      return 0;
    case 'restore': {
      const url = need('db');
      await restore(need('backup'), url);
      print(await reapplyLedger(url, values.ledger ? readLedgerExport(values.ledger) : []));
      return 0;
    }
    case 'drill': {
      const url = need('db');
      const dir = need('dir');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
      const file = join(dir, `backup-${stamp}.dump`);
      const ledger = join(dir, `ledger-${stamp}.json`);
      const target = new URL(url);
      target.pathname = `${target.pathname.slice(1)}_drill`;
      await backup(url, file);
      await exportLedger(url, ledger);
      await dropDatabase(target.href);
      await restore(file, target.href);
      const reapplied = await reapplyLedger(target.href, readLedgerExport(ledger));
      const [source, restored] = [await tableCounts(url), await tableCounts(target.href)];
      const differences = Object.keys(source).filter((table) => source[table] !== restored[table]);
      print({ backup: file, ledger, reapplied, source, restored, differences });
      if (!values.keep) await dropDatabase(target.href);
      return differences.length === 0 ? 0 : 1;
    }
    default:
      throw new Usage(`unknown command ${command ?? '(none)'}; see the comment at the top of tools/cutover/src/cli.ts`);
  }
}

/**
 * What may be printed of a failure. A Drizzle query error's message carries the query's
 * parameters (keys, email addresses), a Postgres error's detail the conflicting values, and an
 * ArkType error the offending value, so only codes, constraint names, paths and our own messages
 * are shown.
 */
function describe(error: unknown): string {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('severity' in cause && 'code' in cause) {
      const constraint = 'constraint_name' in cause && cause.constraint_name ? ` (${String(cause.constraint_name)})` : '';
      return `database error ${String(cause.code)}${constraint}: ${cause.message}`;
    }
  }
  if (error instanceof Error && error.name === 'DrizzleQueryError') return 'a database query failed (its parameters are withheld)';
  if (error instanceof Error && 'arkErrors' in error && Array.isArray(error.arkErrors)) {
    const paths = error.arkErrors.map(
      (e: { propString?: string; expected?: string }) => `${e.propString || '(root)'} must be ${e.expected}`,
    );
    return `the file does not match its format: ${paths.join('; ')}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown failure';
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(describe(error));
  process.exitCode = error instanceof Usage ? 64 : 1;
} finally {
  await closePools();
}
