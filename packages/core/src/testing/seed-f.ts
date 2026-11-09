import type { ActingPrincipal } from '@peblish/schema/authz';
import { authUser } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane F's seeds: local people with accounts (two-factor and a verified email as asked), a
// remote instance, and a sample community definition. Test code only.

type Instance = { id: string; domain: string; local: boolean };

/**
 * A local Person with a better-auth account. Admins have two-factor on unless `twoFactor` says
 * otherwise (an admin counts as one only then); the email counts as verified, which post.create
 * wants before it looks at the community.
 */
export async function seedPerson(
  instance: Instance,
  name: string,
  { admin = false, twoFactor = admin, emailVerified = true }: { admin?: boolean; twoFactor?: boolean; emailVerified?: boolean } = {},
) {
  const [user] = await writer()
    .insert(authUser)
    .values({
      name,
      email: `${name.toLowerCase()}@${instance.domain}`,
      role: admin ? 'admin' : 'user',
      twoFactorEnabled: twoFactor,
      emailVerified,
    })
    .returning();
  return seedActor(instance, 'Person', name, { userId: user!.id });
}

/** A signed-in principal for `actorId`; `admin` is what the session reports (two-factor on). */
export const person = (actorId: string, siteRole: 'user' | 'admin' = 'user'): ActingPrincipal => ({ kind: 'local', actorId, siteRole });

/** A peer's actor delivering directly, with no Announce. */
export const remote = (actorId: string): ActingPrincipal => ({ kind: 'remote', actorId, announcedBy: null });

/**
 * The cast of the community tests, on the local instance `feddit.test` (origin
 * https://feddit.test) and a remote one: an admin with two-factor, an admin without it, and
 * plain people.
 */
export async function seedCommunityWorld() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const people = {
    admin: await seedPerson(local, 'andrew', { admin: true }),
    adminWithoutTwoFactor: await seedPerson(local, 'dana', { admin: true, twoFactor: false }),
    user: await seedPerson(local, 'mira'),
    member: await seedPerson(local, 'ben'),
    moderator: await seedPerson(local, 'olive'),
    other: await seedPerson(local, 'otto'),
    remoteUser: await seedActor(lemmy, 'Person', 'someone'),
  };
  return { instances: { local, lemmy }, people };
}

/** A community definition with every field set, for create and update. */
export const sampleCommunity = {
  displayName: 'Local news',
  description: 'News that **matters** to the fediverse.',
  sensitive: false,
  nsfl: false,
  postingRestrictedToMods: false,
  postingWarning: 'Read the rules before you post.',
  languages: ['en', 'de'],
  rules: [
    { title: 'Be civil', body: 'No harassment, slurs or *dogpiling*.' },
    { title: 'Stay on topic' },
    { title: 'No spam', body: null },
  ],
};
