import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';

// scripts/check-dco.sh against a throwaway repository.
const repo = mkdtempSync(join(tmpdir(), 'peblish-dco-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const human = { name: 'Andrew', email: 'andrew@example.test' };
const bot = { name: 'renovate[bot]', email: '29139614+renovate[bot]@users.noreply.github.com' };

function commit(author: { name: string; email: string }, signed: boolean) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'change', ...(signed ? ['-s'] : [])], { env });
  return git('rev-parse', 'HEAD');
}

const check = (base: string, head: string) =>
  spawnSync('sh', [join(import.meta.dirname, 'check-dco.sh'), base, head], { cwd: repo, encoding: 'utf8' });

test('signed human commits and bot commits pass; an unsigned human commit fails', () => {
  git('init', '-q');
  const base = commit(human, true);
  commit(human, true);
  const botHead = commit(bot, false);
  expect(check(base, botHead)).toMatchObject({ status: 0, stdout: expect.stringContaining('is a bot commit') });
  const unsigned = commit(human, false);
  expect(check(base, unsigned)).toMatchObject({
    status: 1,
    stdout: expect.stringContaining("has no 'Signed-off-by: Andrew <andrew@example.test>'"),
  });
});
