import { moderatedAmong, readCommunity } from '@peblish/core/communities/read';
import { localHandles } from '@peblish/core/identity/handles';
import { showNsfw } from '@peblish/core/communities/gate';
import { readPost } from '@peblish/core/posts/read';
import { readSetting } from '@peblish/core/settings/read';
import { Uuid } from '@peblish/schema/ids';
import { markdownMaxLength } from '@peblish/schema/markdown';
import type { SessionView } from '@peblish/schema/session';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession, sameOrigin } from '../../server/auth.ts';
import { createMarkdownRenderer, type MarkdownRenderer } from '../../server/markdown.ts';
import { communityPath } from '../../shell/paths.ts';
import { readFlash } from './-flash.ts';
import { ageAllows, pickerFor } from './-picker.ts';
import type { CommunityPanel, ComposerData, EditTarget } from './-types.ts';
import { input } from '../../server/input.ts';

// What the composer page and the sheet load: the communities the person may pick, the panel of
// the chosen one, and the post being edited. Server functions, so the page's loader runs them on
// the server and the sheet calls them over fetch.

/** The community a post may go to is also one the person can moderate: restricted ones admit only staff. */
async function canPostIn(viewer: SessionView, community: { id: string; restricted: boolean }): Promise<boolean> {
  if (!community.restricted || viewer.siteRole === 'admin') return true;
  return (await moderatedAmong(viewer.actorId, [community.id])).has(community.id);
}

async function panelFor(communityId: string, viewer: SessionView, renderer: MarkdownRenderer): Promise<CommunityPanel | null> {
  if (!Uuid.allows(communityId)) return null;
  const community = await readCommunity({ id: communityId });
  // Removed, deleted, or age-gated for someone who has not declared 16+: it does not exist for them.
  if (!community || !ageAllows(viewer, community)) return null;
  const restricted = community.postingRestrictedToMods;
  const content = { kind: 'actor', id: community.actor.id, apId: community.actor.apId } as const;
  const summary = community.summaryMd
    ? renderer.render(community.summaryMd, { excerptLength: 240, content }).excerpt
    : community.summaryHtml
      ? renderer.sanitize(community.summaryHtml, { excerptLength: 240, content }).excerpt
      : '';
  return {
    id: community.actor.id,
    handle: community.actor.handle,
    href: communityPath(community.actor),
    summary: summary || null,
    warning: community.postingWarning,
    rules: community.rules.map(({ title, bodyMd }) => ({ title, html: bodyMd ? renderer.render(bodyMd, { content }).html : null })),
    // An NSFL community marks every post sensitive too (createPost).
    sensitive: community.sensitive || community.nsfl,
    restricted,
    canPost: await canPostIn(viewer, { id: community.actor.id, restricted }),
  };
}

/** The author's own post, for the edit form; why it cannot be edited otherwise. */
async function editTarget(
  id: string,
  viewer: SessionView,
): Promise<EditTarget | 'not-found' | 'not-author' | 'deleted' | 'removed' | 'gated'> {
  const page = await readPost(id, { actorId: viewer.actorId, siteRole: viewer.siteRole }, undefined, showNsfw);
  if (!page) return 'not-found';
  const { view } = page;
  // Someone else's post is not the viewer's to see in an edit form, whatever the page shows them.
  if (view.author.id !== viewer.actorId) return 'not-author';
  if (view.deleted) return 'deleted';
  if (view.removed) return 'removed';
  // A sensitive post withholds its words from someone without a 16+ declaration; an edit would save blanks over them.
  if (page.gate === 'sign-in' || page.gate === 'age') return 'gated';
  const community = await readCommunity({ id: view.community.id });
  return {
    id: view.id,
    community: view.community.id,
    title: view.title,
    url: view.url,
    bodyMd: page.body?.kind === 'markdown' ? page.body.source : '',
    // A community age-gated as sensitive marks every post in it; the post's own flag is the rest.
    sensitive: view.sensitive || community?.sensitive === true || community?.nsfl === true,
  };
}

/**
 * The composer's data for the signed-in person: for a new post, the picker and (with
 * `community`, an id or a handle) the community to start in; for an edit, the post and its
 * community.
 */
export const loadComposer = createServerFn({ method: 'GET' })
  .validator(input(type({ 'edit?': 'string | undefined', 'community?': 'string | undefined', 'flash?': 'string | undefined' })))
  .handler(async ({ data }): Promise<ComposerData> => {
    const session = await pageSession();
    if (!session) return { status: 'unavailable', reason: 'signed-out' };
    const { view } = session;
    const renderer = await createMarkdownRenderer();
    const target = data.edit === undefined ? null : await editTarget(data.edit, view);
    if (typeof target === 'string') return { status: 'unavailable', reason: target };
    // What a refused post had typed (without JavaScript), kept for this person by the POST handler.
    const kept = readFlash(data.flash, view.actorId);
    // An edit's own community; else the one the words were meant for, then the one asked for in the URL, where the person may post.
    const { communities, truncated, selected } = await pickerFor(view, {
      edit: target ? target.community : null,
      wanted: [kept?.community, data.community],
    });
    const [handles, uploads, panel] = await Promise.all([
      localHandles(),
      readSetting('uploads.enabled'),
      selected ? panelFor(selected, view, renderer) : null,
    ]);
    return {
      status: 'ready',
      actorId: view.actorId,
      me: `@${handles.handle(view.name).handle}`,
      communities,
      pickerTruncated: truncated,
      selected,
      panel,
      uploads,
      edit: target,
      kept,
    };
  });

/**
 * The panel for a community picked in the form; `panel` is null for one that does not exist for
 * this viewer (removed, deleted, age-gated without a 16+ declaration) or without a session. Wrapped
 * because a server function that returns a bare null is answered with a 500.
 */
export const loadCommunityPanel = createServerFn({ method: 'GET' })
  .validator(input(type({ id: 'string' })))
  .handler(async ({ data }): Promise<{ panel: CommunityPanel | null }> => {
    const session = await pageSession();
    return { panel: session ? await panelFor(data.id, session.view, await createMarkdownRenderer()) : null };
  });

/**
 * Preview: the server renders the body with the renderer the post page uses, so what shows
 * here is what gets published. `postId` is given when editing, so footnote anchors carry the
 * id the published page gives them; a new post has none yet. A signed-out or cross-site call answers null.
 */
export const previewBody = createServerFn({ method: 'POST' })
  .validator(input(type({ source: `string <= ${markdownMaxLength}`, 'postId?': Uuid })))
  .handler(async ({ data }): Promise<{ html: string } | null> => {
    const session = sameOrigin(getRequest()) ? await pageSession() : null;
    if (!session) return null;
    const { html } = (await createMarkdownRenderer()).render(data.source, data.postId ? { idPrefix: data.postId } : {});
    return { html };
  });
