// `make interop [PEERS="lemmy piefed mbin"] [ONLY=F1,P1]`: runs the scenario groups against the
// peers and writes lab/data/results/interop.json. One process per group, because authorization
// caches (moderators, roles) live in the process and a group must see peblish as the worker left it.
//
//   node src/run.ts [lemmy|piefed|mbin ...] [--only=F1,P1] [--slow]
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Context, type Group } from './context.ts';
import { type Result, recorder, RESULTS_DIR, runId } from './lab.ts';
import { ledger } from './ledger.ts';
import { closeAll, localActorId, sql } from './peblish.ts';
import { selectPeers } from './peers/index.ts';
import { groups } from './scenarios/index.ts';

const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
const slow = args.includes('--slow');
const peerNames = args.filter((a) => !a.startsWith('--'));
const groupArg = args.find((a) => a.startsWith('--group='))?.slice('--group='.length);

/** Child mode: run one group in this process and write its results to a numbered file. */
async function runGroup(name: string): Promise<number> {
  const group: Group | undefined = groups[name];
  if (!group) throw new Error(`no scenario group ${name}`);
  const rec = recorder(only);
  const community = await localActorId('Group', 'lab').then(async (id) => {
    const [row] = await sql()<{ ap_id: string }[]>`select ap_id from actors where id = ${id}`;
    return { id, apId: row!.ap_id, handle: '!lab@peblish.lab.test', name: 'lab' };
  });
  const run = runId();
  const ctx: Context = { rec, peers: selectPeers(peerNames), run, since: new Date(), sql: sql(), ledger: ledger(run), community, slow };
  try {
    await group.run(ctx);
  } finally {
    await closeAll();
  }
  return rec.finish(`group-${name}.json`, run);
}

if (groupArg) {
  process.exitCode = await runGroup(groupArg);
} else {
  let failed = 0;
  const forwarded = [...peerNames, ...(only ? [`--only=${only.join(',')}`] : []), ...(slow ? ['--slow'] : [])];
  const all: Result[] = [];
  for (const [name, group] of Object.entries(groups)) {
    if (only && !group.ids.some((id) => only.includes(id))) continue;
    console.log(`\n== ${name}`);
    rmSync(`${RESULTS_DIR}/group-${name}.json`, { force: true });
    const child = spawnSync(process.execPath, [import.meta.filename, `--group=${name}`, ...forwarded], { stdio: 'inherit' });
    if (child.status !== 0) failed += 1;
    try {
      all.push(...(JSON.parse(readFileSync(`${RESULTS_DIR}/group-${name}.json`, 'utf8')) as { results: Result[] }).results);
    } catch {
      failed += 1;
      console.log(`group ${name} wrote no results`);
    }
  }
  const count = (status: string) => all.filter((r) => r.status === status).length;
  const pending = all.filter((r) => r.status.startsWith('pending')).length;
  writeFileSync(
    `${RESULTS_DIR}/interop.json`,
    `${JSON.stringify({ at: new Date().toISOString(), peers: peerNames, results: all }, null, 2)}\n`,
  );
  console.log(
    `\nTotal: ${count('pass')} pass, ${count('fail')} fail, ${count('known')} known, ${count('n/a')} n/a, ${pending} pending (interop.json)`,
  );
  process.exitCode = failed > 0 || count('fail') > 0 ? 1 : 0;
}
