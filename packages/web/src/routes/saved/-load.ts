import { readSaved } from '@peblish/core/saves/read';
import { createServerFn } from '@tanstack/react-start';
import { redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { input } from '../../server/input.ts';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { savedPath } from '../../shell/paths.ts';
import { feedItem, type FeedItem } from '../index/-feed/items.ts';

/** One saved post: the feed's item (its picture already through the proxy rule) and when it was saved. */
export type SavedItem = FeedItem & { savedAt: string };

export type SavedData = { items: SavedItem[]; next: string | null; now: string };

/**
 * The viewer's Saved page (a server function: private, it depends on who asks). A signed-out
 * visitor is sent to sign in and back. Rows are what core's readSaved lets through (the feeds'
 * visibility, block and age rules), mapped like a feed's so no remote picture address reaches the page.
 */
export const loadSaved = createServerFn({ method: 'GET' })
  .validator(input(type({ 'cursor?': 'string <= 400' })))
  .handler(async ({ data }): Promise<SavedData> => {
    const session = await pageSession();
    const here = data.cursor ? `${savedPath}?cursor=${encodeURIComponent(data.cursor)}` : savedPath;
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: here } });
    const page = await readSaved({ actorId: session.view.actorId, siteRole: session.view.siteRole }, { cursor: data.cursor });
    const renderer = await createMarkdownRenderer();
    return {
      items: page.items.map(({ savedAt, ...post }) => ({ ...feedItem(post, renderer.image), savedAt })),
      next: page.nextCursor,
      now: new Date().toISOString(),
    };
  });
