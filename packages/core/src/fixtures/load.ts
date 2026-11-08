import { readFileSync } from 'node:fs';
import { type } from 'arktype';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { FixtureSet } from './set.ts';

// Seeds a test database with a named fixture set, through the public tables only (no
// accounts, no keys). Other lanes' tests call it after their per-file truncate:
//
//   const lab = await loadFixtureSet('lab-live');
//   const post = lab.id('https://lemmy.lab.test/post/10');
//
// Everything loads as remote unless `localDomain` names one of the set's instances, which
// then becomes the local instance (the database must not have one yet) with its rows local
// and their raw JSON dropped. Load a set once per database: its ap_ids are unique.

export const fixtureSets = { 'lab-live': 'sets/lab-live.json' } as const;
export type FixtureSetName = keyof typeof fixtureSets;

export function readFixtureSet(name: FixtureSetName): FixtureSet {
  const json: unknown = JSON.parse(readFileSync(new URL(fixtureSets[name], import.meta.url), 'utf8'));
  const set = FixtureSet(json);
  if (set instanceof type.errors) throw new Error(`fixture set ${name}: ${set.summary}`);
  return set;
}

export type LoadedFixtureSet = {
  set: FixtureSet;
  /** The uuid of the row stored under `apId` (instances by domain); throws for an unknown one. */
  id(apId: string): string;
};

export async function loadFixtureSet(name: FixtureSetName, options: { localDomain?: string } = {}): Promise<LoadedFixtureSet> {
  const set = readFixtureSet(name);
  const { localDomain } = options;
  if (localDomain !== undefined && !set.instances.some((instance) => instance.domain === localDomain)) {
    throw new Error(`fixture set ${name} has no instance ${localDomain}`);
  }
  const localIds = new Set(set.instances.filter((instance) => instance.domain === localDomain).map((instance) => instance.id));
  // Content authored here has no raw JSON (the identity spine's rule), so local rows drop it.
  const spine = <T extends { instanceId: string; raw: unknown }>(row: T) =>
    localIds.has(row.instanceId) ? { ...row, local: true, raw: null } : { ...row, local: false };
  await writer().transaction(async (t) => {
    await t.insert(instances).values(set.instances.map((instance) => ({ ...instance, local: localIds.has(instance.id) })));
    if (set.actors.length) await t.insert(actors).values(set.actors.map(spine));
    if (set.communityLanguages.length) await t.insert(communityLanguages).values(set.communityLanguages);
    if (set.posts.length) await t.insert(posts).values(set.posts.map(spine));
    if (set.comments.length) await t.insert(comments).values(set.comments.map(spine));
    if (set.votes.length) await t.insert(votes).values(set.votes.map(spine));
    if (set.follows.length) await t.insert(follows).values(set.follows);
  });
  const ids = new Map<string, string>([
    ...set.instances.map((row) => [row.domain, row.id] as const),
    ...[...set.actors, ...set.posts, ...set.comments, ...set.votes].map((row) => [row.apId, row.id] as const),
  ]);
  return {
    set,
    id(apId) {
      const id = ids.get(apId);
      if (id === undefined) throw new Error(`fixture set ${name} has no row for ${apId}`);
      return id;
    },
  };
}
