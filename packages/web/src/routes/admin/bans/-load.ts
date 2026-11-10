import { contentCounts, findActorByHandle, listSiteBans, type SiteBanRow } from '@peblish/core/bans/read';
import type { ActorRef } from '@peblish/schema/views';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { type Access, accessOf } from '../settings/-access.ts';

export type BansData =
  | { access: Exclude<Access, 'ok'> }
  | {
      access: 'ok';
      bans: SiteBanRow[];
      /** The person the form asked about: found, with the counts a ban would remove, or the handle asked after that nobody holds. */
      candidate: { person: ActorRef; counts: { posts: number; comments: number }; banned: boolean } | { missing: string } | null;
    };

export const loadBans = createServerFn({ method: 'GET' })
  .validator(type({ 'person?': 'string' }))
  .handler(async ({ data }): Promise<BansData> => {
    const session = await pageSession();
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: adminPaths.bans } });
    // Signed in but not an admin whose session passed two-factor: the denial copy, answered as a 403 (as the report queue does).
    const access = accessOf(session);
    if (access !== 'ok') {
      setResponseStatus(403);
      return { access };
    }
    const bans = await listSiteBans();
    const handle = data.person?.trim();
    if (!handle) return { access: 'ok', bans, candidate: null };
    // A site ban takes a bot (a Service) as well as a person.
    const person = await findActorByHandle(handle, ['Person', 'Service']);
    if (!person) return { access: 'ok', bans, candidate: { missing: handle } };
    return {
      access: 'ok',
      bans,
      candidate: { person, counts: await contentCounts(person.id), banned: bans.some((ban) => ban.person.id === person.id) },
    };
  });
