import { followedCommunities } from '@peblish/core/follows/read';
import { listLocalCommunities, listModerators, readCommunity } from '@peblish/core/communities/read';
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
import type { CommunityPanel, ComposerData, EditTarget, PickerCommunity } from './-types.ts';

// What the composer page and the sheet load: the communities the person may pick, the panel of
// the chosen one, and the post being edited. Server functions, so the page's loader runs them on
// the server and the sheet calls them over fetch.

/** The community a post may go to is also one the person can moderate: restricted ones admit only staff. */
async function canPostIn(viewer: SessionView, community: { id: string; restricted: boolean }): Promise<boolean> {
  if (!community.restricted || viewer.siteRole === 'admin') return true;
  return (await listModerators(community.id)).some(({ actor }) => actor.id === viewer.actorId);
}

/**
 * The age gate (C10, the feeds' rule): a sensitive or NSFL community is for someone who declared
 * 16+; to anyone else it does not exist, in the picker and in its panel alike.
 */
const ageAllows = (viewer: SessionView, community: { sensitive: boolean; nsfl: boolean }) =>
  viewer.ageDeclaredAt !== null || !(community.sensitive || community.nsfl);

/**
 * Local communities, then the remote ones the person follows (accepted follows only). A
 * community age-gated as sensitive or NSFL is listed only for someone who declared 16+, a
 * removed one never, and a mods-only one is disabled for anyone who is not staff there.
 */
async function pickable(viewer: SessionView): Promise<PickerCommunity[]> {
  const [local, followed] = await Promise.all([
    listLocalCommunities({ includeSensitive: viewer.ageDeclaredAt !== null }),
    followedCommunities(viewer.actorId),
  ]);
  const rows = await Promise.all(
    local.map(async ({ actor, postingRestrictedToMods, subscribers }): Promise<PickerCommunity> => ({
      id: actor.id,
      handle: actor.handle,
      local: true,
      subscribers,
      restricted: postingRestrictedToMods,
      canPost: await canPostIn(viewer, { id: actor.id, restricted: postingRestrictedToMods }),
    })),
  );
  const remote = await Promise.all(
    followed
      .filter((community) => !community.local && community.state === 'accepted' && ageAllows(viewer, community))
      .map(async ({ id, name, host, postingRestrictedToMods }): Promise<PickerCommunity> => ({
        id,
        handle: `${name}@${host}`,
        local: false,
        subscribers: null,
        restricted: postingRestrictedToMods,
        canPost: await canPostIn(viewer, { id, restricted: postingRestrictedToMods }),
      })),
  );
  return [...rows, ...remote];
}

async function panelFor(communityId: string, viewer: SessionView, renderer: MarkdownRenderer): Promise<CommunityPanel | null> {
  if (!Uuid.allows(communityId)) return null;
  const community = await readCommunity({ id: communityId });
  // Removed, deleted, or age-gated for someone who has not declared 16+: it does not exist for them.
  if (!community || !ageAllows(viewer, community)) return null;
  const restricted = community.postingRestrictedToMods;
  const summary = community.summaryMd
    ? renderer.render(community.summaryMd, { excerptLength: 240 }).excerpt
    : community.summaryHtml
      ? renderer.sanitize(community.summaryHtml, { excerptLength: 240 }).excerpt
      : '';
  return {
    id: community.actor.id,
    handle: community.actor.handle,
    href: communityPath(community.actor),
    summary: summary || null,
    warning: community.postingWarning,
    rules: community.rules.map(({ title, bodyMd }) => ({ title, html: bodyMd ? renderer.render(bodyMd).html : null })),
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
  .validator(type({ 'edit?': 'string | undefined', 'community?': 'string | undefined', 'flash?': 'string | undefined' }))
  .handler(async ({ data }): Promise<ComposerData> => {
    const session = await pageSession();
    if (!session) return { status: 'unavailable', reason: 'signed-out' };
    const { view } = session;
    const renderer = await createMarkdownRenderer();
    const target = data.edit === undefined ? null : await editTarget(data.edit, view);
    if (typeof target === 'string') return { status: 'unavailable', reason: target };
    const communities = await pickable(view);
    // What a refused post had typed (without JavaScript), kept for this person by the POST handler.
    const kept = readFlash(data.flash, view.actorId);
    // The community the words were meant for, if it is still one to pick, then the one asked for in the URL.
    const pick = (key: string | null | undefined) => {
      const wanted = key?.trim().toLowerCase();
      if (!wanted) return undefined;
      return communities.find(({ id, handle }) => id === wanted || handle.toLowerCase() === wanted.replace(/^!/, ''))?.id;
    };
    const selected = target ? target.community : (pick(kept?.community) ?? pick(data.community) ?? null);
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
  .validator(type({ id: 'string' }))
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
  .validator(type({ source: `string <= ${markdownMaxLength}`, 'postId?': Uuid }))
  .handler(async ({ data }): Promise<{ html: string } | null> => {
    const session = sameOrigin(getRequest()) ? await pageSession() : null;
    if (!session) return null;
    const { html } = (await createMarkdownRenderer()).render(data.source, data.postId ? { idPrefix: data.postId } : {});
    return { html };
  });
