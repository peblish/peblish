import { contentCounts, findActorByHandle, listSiteBans, type SiteBanRow } from '@peblish/core/bans/read';
import type { ActorRef } from '@peblish/schema/views';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { adminPaths } from '../../../shell/paths.ts';

export type BansData =
  | { access: 'not-admin' | 'needs-two-factor' }
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
    if (session.role !== 'admin') return { access: 'not-admin' };
    if (session.view.siteRole !== 'admin') return { access: 'needs-two-factor' };
    const bans = await listSiteBans();
    const handle = data.person?.trim();
    if (!handle) return { access: 'ok', bans, candidate: null };
    const person = await findActorByHandle(handle, 'Person');
    if (!person) return { access: 'ok', bans, candidate: { missing: handle } };
    return {
      access: 'ok',
      bans,
      candidate: { person, counts: await contentCounts(person.id), banned: bans.some((ban) => ban.person.id === person.id) },
    };
  });
