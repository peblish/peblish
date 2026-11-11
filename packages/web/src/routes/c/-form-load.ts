import { authorize } from '@peblish/core/authz/authorize';
import { findCommunityId, readCommunity } from '@peblish/core/communities/read';
import { readSetting } from '@peblish/core/settings/read';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession, principalOf } from '../../server/auth.ts';
import { emptyValues, type FormValues } from './-form.ts';
import { input } from '../../server/input.ts';

// What the community form pages load (server functions). A signed-out viewer is sent to sign in
// by the route; a viewer who may not use the form sees the reason in place, with status 403.

export type FormData =
  | { status: 'signed-out' }
  | { status: 'refused'; reason: string }
  | { status: 'missing' }
  | { status: 'ok'; handle: string | null; initial: FormValues; uploadsOff: boolean };

const refused = (reason: string): FormData => {
  setResponseStatus(403);
  return { status: 'refused', reason };
};

/** /c/new: a site admin with two-factor on (the session's admin role). */
export const loadNewCommunity = createServerFn({ method: 'GET' }).handler(async (): Promise<FormData> => {
  const session = await pageSession();
  if (!session) return { status: 'signed-out' };
  if (session.view.siteRole !== 'admin') return refused('auth.admin_required');
  return { status: 'ok', handle: null, initial: emptyValues, uploadsOff: !(await readSetting('uploads.enabled')) };
});

/** /c/<handle>/edit: the owner, a moderator or a site admin of a community of this server. */
export const loadEditCommunity = createServerFn({ method: 'GET' })
  .validator(input(type({ handle: 'string' })))
  .handler(async ({ data }): Promise<FormData> => {
    const session = await pageSession();
    const id = await findCommunityId(data.handle);
    const community = id ? await readCommunity({ id }) : null;
    if (!id || !community) return { status: 'missing' };
    if (!session) return { status: 'signed-out' };
    if (!community.actor.local) return refused('community.not_local');
    const decision = await authorize('community.update', principalOf(session.view), { communityId: id });
    if (!decision.ok) return refused(decision.reason);
    return {
      status: 'ok',
      handle: data.handle,
      uploadsOff: !(await readSetting('uploads.enabled')),
      initial: {
        name: community.actor.name,
        displayName: community.actor.displayName ?? '',
        description: community.summaryMd ?? '',
        rules: community.rules.map((rule) => ({ title: rule.title, body: rule.bodyMd ?? '' })),
        languages: community.languages,
        sensitive: community.sensitive,
        nsfl: community.nsfl,
        restricted: community.postingRestrictedToMods,
        discoverable: community.discoverable,
        indexable: community.indexable,
      },
    };
  });
