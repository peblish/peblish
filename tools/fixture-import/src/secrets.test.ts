import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { coreSetsDir, federationFixturesDir } from './paths.ts';
import { findSecrets } from './secrets.ts';

it('finds no private key and no email address in any generated fixture file', () => {
  const files = [
    join(federationFixturesDir, 'manifest.json'),
    ...globSync('wire/**/*.json', { cwd: federationFixturesDir }).map((path) => join(federationFixturesDir, path)),
    ...globSync('*.json', { cwd: coreSetsDir }).map((path) => join(coreSetsDir, path)),
  ];
  expect(files.length).toBeGreaterThan(100);
  expect(files.flatMap((path) => findSecrets(JSON.parse(readFileSync(path, 'utf8')), path))).toEqual([]);
});

it('flags key material and email addresses but not handles or addresses inside URLs', () => {
  const pem = ['-----BEGIN', 'PRIVATE KEY-----\nMIIEvQ\n-----END', 'PRIVATE KEY-----'].join(' ');
  const planted = { a: { privateKey: 'x' }, b: [`text ${pem}`], c: 'write to someone@example.org today', d: { email: null } };
  expect(findSecrets(planted)).toEqual([
    '$.a.privateKey: forbidden field',
    '$.b[0]: private key',
    '$.c: email address someone@example.org',
    '$.d.email: forbidden field',
  ]);
  const handles = {
    name: '@lemmyuser@lemmy.lab.test',
    title: 'post in !lab@lemmy.lab.test',
    id: 'https://piefed.lab.test/c/spike@feddit.lab.test/p/14/x',
  };
  expect(findSecrets(handles)).toEqual([]);
});
