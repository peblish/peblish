import { blockCounts, listBlocks, listInstanceBlocks, type BlockKind } from '@peblish/core/blocks/actions';
import { createServerFn } from '@tanstack/react-start';
import { redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { blocksHref, blocksPath, blockTabs, kindOfTab, type BlockTab } from './-tabs.ts';
import { input } from '../../../server/input.ts';

/** One line of a list: who or what is blocked, when, and (for an instance) what that hides. */
export type BlockRow = {
  id: string;
  /** `name@host` for a remote person or community, `name` for a local one, the host for an instance. */
  handle: string;
  blockedAt: string;
  hides: { people: number; communities: number } | null;
};

export type BlocksData = {
  admin: boolean;
  tab: BlockTab;
  counts: Record<BlockKind, number>;
  rows: BlockRow[];
  /** The block just made (`?just=`), when it is in the list: its id and name for the Undo line. */
  just: { id: string; name: string } | null;
};

/** The page's data (a server function: private, as it depends on who asks). A signed-out visitor is sent to sign in. */
export const loadBlocks = createServerFn({ method: 'GET' })
  .validator(input(type({ tab: type.enumerated(...blockTabs), 'just?': 'string' })))
  .handler(async ({ data }): Promise<BlocksData> => {
    const session = await pageSession();
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: blocksHref(data.tab) } });
    const me = session.view.actorId;
    const kind = kindOfTab[data.tab];
    const [counts, rows] = await Promise.all([
      blockCounts(me),
      kind === 'instance'
        ? listInstanceBlocks(me).then((list) =>
            list.map(({ id, domain, blockedAt, people, communities }): BlockRow => ({
              id,
              handle: domain,
              blockedAt,
              hides: { people, communities },
            })),
          )
        : listBlocks(me, kind).then((list) =>
            list.map(({ actor, blockedAt }): BlockRow => ({ id: actor.id, handle: actor.handle, blockedAt, hides: null })),
          ),
    ]);
    const found = data.just ? rows.find((row) => row.id === data.just) : undefined;
    return {
      admin: session.role === 'admin',
      tab: data.tab,
      counts,
      rows,
      just: found ? { id: found.id, name: `${kind === 'person' ? '@' : kind === 'community' ? '!' : ''}${found.handle}` } : null,
    };
  });

export { blocksPath };
