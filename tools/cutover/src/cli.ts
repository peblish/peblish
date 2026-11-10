import { parseArgs } from 'node:util';
import { closePools } from '@peblish/core/db/pools';
import { crossCheckKeyFiles, exportBundle, inventory } from './archive.ts';
import { readBundle, rehostBundle, writeBundle } from './bundle.ts';
import { backup, exportLedger, reapplyLedger, readLedgerExport, restore, runDrill } from './drill.ts';
import { CutoverError, describe } from './errors.ts';
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
//   node tools/cutover/src/cli.ts restore --backup <file> --db <new database url> [--ledger <file>]   (refuses an existing database)
//   node tools/cutover/src/cli.ts drill --db <url> --dir <scratch folder> [--keep]                  (restores into a new drill_<time>_<random>)
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

class Usage extends CutoverError {}

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
        }), ${bundle.communities.length} communities, ${bundle.remoteCommunities.length} remote communities, ${bundle.follows.length} follows, ${bundle.blockedInstances.length} banned instances`,
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
        for (const p of report.problems) console.log(`${p.apId}: ${p.problem}`);
        if (report.keys.length === 0) console.log('no imported actor with a key was found');
        print(report.summary);
        console.log(report.ok ? 'verify passed' : 'verify FAILED');
      }
      return report.ok ? 0 : 1;
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
      const ledger = values.ledger ? readLedgerExport(values.ledger) : [];
      await restore(need('backup'), url);
      print(await reapplyLedger(url, ledger));
      return 0;
    }
    case 'drill': {
      const report = await runDrill(need('db'), need('dir'), { keep: values.keep === true });
      print(report);
      return report.differences.length === 0 ? 0 : 1;
    }
    default:
      throw new Usage(`unknown command ${command ?? '(none)'}; see the comment at the top of tools/cutover/src/cli.ts`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(describe(error));
  process.exitCode = error instanceof Usage ? 64 : 1;
} finally {
  await closePools();
}
