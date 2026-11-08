import type { FixtureSetJson } from '@peblish/core/fixtures/set';
import { fromWire } from '@peblish/federation/mapping/document';
import type {
  Activity,
  ActorRecord,
  CommentRecord,
  ContentObject,
  FollowRecord,
  PostRecord,
  VoteRecord,
} from '@peblish/federation/mapping/records';
import { isLabHost, lab, type Candidate } from './captures.ts';
import { fixtureUuid } from './ids.ts';

// Builds the lab-live fixture set by replaying the corpus in capture order, the way an inbox
// would: Create and Update upsert, Delete marks deleted (by the author) or removed (by a
// moderator), Undo reverses, Lock and the featured collection set the flags, Follow and
// Accept make follows, Like and Dislike make votes. The spike's own actors were never
// fetched, so actors seen only as references get a row from their URL (raw null).

type Post = { record: PostRecord; at: Date; deletedAt: Date | null; removedAt: Date | null; locked: boolean; featured: boolean };
type Comment = { record: CommentRecord; at: Date; deletedAt: Date | null; removedAt: Date | null };
type State = {
  actors: Map<string, ActorRecord>;
  groups: Set<string>;
  posts: Map<string, Post>;
  comments: Map<string, Comment>;
  votes: Map<string, { vote: VoteRecord; at: Date }>;
  follows: Map<string, { follow: FollowRecord; at: Date; accepted: boolean }>;
};

const pair = (a: string, b: string) => `${a} ${b}`;

function upsert(state: State, object: ContentObject, at: Date): void {
  if (object.type === 'Page') {
    const post = object.post;
    const old = state.posts.get(post.apId);
    state.groups.add(post.communityApId);
    state.posts.set(post.apId, {
      record: { ...post, publishedAt: old?.record.publishedAt ?? post.publishedAt },
      at: old?.at ?? at,
      deletedAt: old?.deletedAt ?? null,
      removedAt: old?.removedAt ?? null,
      locked: post.locked ?? old?.locked ?? false,
      featured: post.featuredCommunity ?? old?.featured ?? false,
    });
    return;
  }
  const comment = object.comment;
  const old = state.comments.get(comment.apId);
  if (comment.communityApId) state.groups.add(comment.communityApId);
  state.comments.set(comment.apId, {
    record: { ...comment, publishedAt: old?.record.publishedAt ?? comment.publishedAt },
    at: old?.at ?? at,
    deletedAt: old?.deletedAt ?? null,
    removedAt: old?.removedAt ?? null,
  });
}

function apply(state: State, activity: Activity, at: Date, undo = false): void {
  switch (activity.type) {
    case 'Create':
    case 'Update':
      if (undo) return;
      if (activity.object.type === 'Actor') state.actors.set(activity.object.actor.apId, activity.object.actor);
      else upsert(state, activity.object, at);
      return;
    case 'Announce':
      state.groups.add(activity.actorApId);
      if (activity.object.type === 'Page' || activity.object.type === 'Note') upsert(state, activity.object, at);
      else apply(state, activity.object, at, undo);
      return;
    case 'Undo':
      apply(state, activity.object, at, true);
      return;
    case 'Like':
    case 'Dislike': {
      // Lemmy's Undo embeds a fresh Like id, so votes match on voter and target.
      const key = pair(activity.vote.voterApId, activity.vote.targetApId);
      if (undo) state.votes.delete(key);
      else state.votes.set(key, { vote: activity.vote, at });
      return;
    }
    case 'Follow': {
      const key = pair(activity.follow.followerApId, activity.follow.followeeApId);
      if (undo) state.follows.delete(key);
      else if (!state.follows.has(key)) state.follows.set(key, { follow: activity.follow, at, accepted: false });
      return;
    }
    case 'Accept':
    case 'Reject': {
      const follow = activity.object.follow;
      const key = pair(follow.followerApId, follow.followeeApId);
      state.groups.add(follow.followeeApId);
      if (activity.type === 'Reject') state.follows.delete(key);
      else state.follows.set(key, { follow, at: state.follows.get(key)?.at ?? at, accepted: true });
      return;
    }
    case 'Delete': {
      const target = state.posts.get(activity.objectApId) ?? state.comments.get(activity.objectApId);
      if (!target) return;
      const byAuthor = activity.actorApId === target.record.authorApId;
      if (byAuthor) target.deletedAt = undo ? null : at;
      else target.removedAt = undo ? null : at;
      return;
    }
    case 'Lock': {
      const post = state.posts.get(activity.objectApId);
      if (post) post.locked = !undo;
      return;
    }
    case 'Add':
    case 'Remove': {
      const post = state.posts.get(activity.objectApId);
      if (post && activity.targetApId.endsWith('/featured')) post.featured = (activity.type === 'Add') !== undo;
      return;
    }
    case 'Flag':
    case 'Block':
      return;
  }
}

/** The actor row for a URL nobody fetched: name from the path (`/u/name`, `/c/name`, the spike's `/ap/u.name`). */
function synthesize(apId: string, group: boolean): ActorRecord {
  const url = new URL(apId);
  const last = url.pathname.split('/').filter(Boolean).at(-1) ?? url.host;
  return {
    apId,
    kind: group ? 'Group' : 'Person',
    name: last.replace(/^[uc]\./, ''),
    displayName: null,
    summaryHtml: null,
    summaryMd: null,
    inboxUrl: `${apId}/inbox`,
    sharedInboxUrl: `${url.origin}/inbox`,
    outboxUrl: `${apId}/outbox`,
    followersUrl: group ? `${apId}/followers` : null,
    featuredUrl: group ? `${apId}/featured` : null,
    moderatorsUrl: group ? `${apId}/moderators` : null,
    iconUrl: null,
    bannerUrl: null,
    sensitive: false,
    bot: false,
    postingRestrictedToMods: false,
    publishedAt: null,
    updatedAt: null,
    publicKey: null,
    raw: null,
  };
}

const iso = (date: Date | null) => date?.toISOString() ?? null;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildLabLive(candidates: Candidate[]): { set: FixtureSetJson; dropped: string[] } {
  const state: State = {
    actors: new Map(),
    groups: new Set(),
    posts: new Map(),
    comments: new Map(),
    votes: new Map(),
    follows: new Map(),
  };
  const ordered = [...candidates].sort((a, b) => (a.source.at < b.source.at ? -1 : a.source.at > b.source.at ? 1 : 0));
  for (const candidate of ordered) {
    const at = new Date(candidate.source.at);
    const mapped = fromWire(candidate.json);
    if (mapped.kind === 'actor') state.actors.set(mapped.actor.apId, mapped.actor);
    else if (mapped.kind === 'post') upsert(state, { type: 'Page', post: mapped.post }, at);
    else if (mapped.kind === 'comment') upsert(state, { type: 'Note', comment: mapped.comment }, at);
    else if (mapped.kind === 'activity') apply(state, mapped.activity, at);
  }
  const dropped: string[] = [];

  // Actors: every one the rows below reference.
  const referenced = new Set<string>(state.actors.keys());
  for (const { record } of state.posts.values()) referenced.add(record.authorApId).add(record.communityApId);
  for (const { record } of state.comments.values()) referenced.add(record.authorApId);
  for (const { vote } of state.votes.values()) referenced.add(vote.voterApId);
  for (const { follow } of state.follows.values()) referenced.add(follow.followerApId).add(follow.followeeApId);
  const actors = [...referenced].map((apId) => state.actors.get(apId) ?? synthesize(apId, state.groups.has(apId)));
  const domains = [...new Set(actors.map((actor) => new URL(actor.apId).host))].sort();
  const instances = domains.map((domain) => {
    const software = isLabHost(domain) ? lab[domain] : undefined;
    return {
      id: fixtureUuid(`instance:${domain}`, null),
      domain,
      origin: `https://${domain}`,
      software: software?.name ?? null,
      softwareVersion: software?.version ?? null,
    };
  });
  const instanceOf = (apId: string) => fixtureUuid(`instance:${new URL(apId).host}`, null);
  const actorId = new Map(actors.map((actor) => [actor.apId, fixtureUuid(actor.apId, actor.publishedAt)]));
  const idOf = (apId: string) => {
    const id = actorId.get(apId);
    if (id === undefined) throw new Error(`no actor row for ${apId}`);
    return id;
  };

  const posts = [...state.posts.values()].map(({ record, at, deletedAt, removedAt, locked, featured }) => {
    const publishedAt = record.publishedAt ?? at;
    return {
      id: fixtureUuid(record.apId, publishedAt),
      instanceId: instanceOf(record.apId),
      apId: record.apId,
      raw: record.raw,
      authorId: idOf(record.authorApId),
      communityId: idOf(record.communityApId),
      title: record.title,
      url: record.url,
      bodyMd: record.bodyMd,
      contentHtml: record.contentHtml,
      language: record.language,
      sensitive: record.sensitive,
      locked,
      featuredCommunity: featured,
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      publishedAt: publishedAt.toISOString(),
      editedAt: iso(record.editedAt),
      deletedAt: iso(deletedAt),
      removedAt: iso(removedAt),
    };
  });
  const postByApId = new Map(posts.map((post) => [post.apId, post]));

  // Comments: a reply needs its parent first, so resolve in publication order until nothing changes.
  type CommentRow = FixtureSetJson['comments'][number];
  const commentRows = new Map<string, CommentRow>();
  let pending = [...state.comments.values()].sort(
    (a, b) => (a.record.publishedAt ?? a.at).getTime() - (b.record.publishedAt ?? b.at).getTime(),
  );
  for (let progress = true; progress && pending.length > 0;) {
    progress = false;
    pending = pending.filter(({ record, at, deletedAt, removedAt }) => {
      const parent = commentRows.get(record.inReplyToApId);
      const postId = parent?.postId ?? postByApId.get(record.inReplyToApId)?.id;
      if (postId === undefined) return true;
      const publishedAt = record.publishedAt ?? at;
      const id = fixtureUuid(record.apId, publishedAt);
      commentRows.set(record.apId, {
        id,
        instanceId: instanceOf(record.apId),
        apId: record.apId,
        raw: record.raw,
        postId,
        authorId: idOf(record.authorApId),
        parentId: parent?.id ?? null,
        path: parent ? `${parent.path}.${id}` : id,
        bodyMd: record.bodyMd,
        contentHtml: record.contentHtml,
        language: record.language,
        distinguished: record.distinguished,
        upvotes: 0,
        downvotes: 0,
        childCount: 0,
        publishedAt: publishedAt.toISOString(),
        editedAt: iso(record.editedAt),
        deletedAt: iso(deletedAt),
        removedAt: iso(removedAt),
      });
      progress = true;
      return false;
    });
  }
  for (const { record } of pending) dropped.push(`comment ${record.apId}: replies to ${record.inReplyToApId}, which the corpus lacks`);
  const comments = [...commentRows.values()];

  const votes = [...state.votes.values()].flatMap(({ vote, at }) => {
    const post = postByApId.get(vote.targetApId);
    const comment = commentRows.get(vote.targetApId);
    if (!post && !comment) {
      dropped.push(`vote ${vote.apId}: its target ${vote.targetApId} is not in the corpus`);
      return [];
    }
    if (post) post[vote.value === 1 ? 'upvotes' : 'downvotes'] += 1;
    if (comment) comment[vote.value === 1 ? 'upvotes' : 'downvotes'] += 1;
    return [
      {
        id: fixtureUuid(vote.apId, at),
        instanceId: instanceOf(vote.apId),
        apId: vote.apId,
        raw: vote.raw,
        voterId: idOf(vote.voterApId),
        postId: post?.id ?? null,
        commentId: comment?.id ?? null,
        value: vote.value,
      },
    ];
  });
  for (const comment of comments) {
    const post = posts.find((row) => row.id === comment.postId);
    if (post) post.commentCount += 1;
    const parent = comment.parentId === null ? undefined : comments.find((row) => row.id === comment.parentId);
    if (parent) parent.childCount += 1;
  }

  const follows = [...state.follows.values()].map(({ follow, at, accepted }) => ({
    id: fixtureUuid(`follow:${follow.apId}`, at),
    followerId: idOf(follow.followerApId),
    followeeId: idOf(follow.followeeApId),
    apId: follow.apId,
    state: accepted ? ('accepted' as const) : ('pending' as const),
  }));

  const actorRows = actors.map((actor) => ({
    id: idOf(actor.apId),
    instanceId: instanceOf(actor.apId),
    apId: actor.apId,
    raw: actor.raw,
    kind: actor.kind,
    name: actor.name,
    displayName: actor.displayName,
    summaryHtml: actor.summaryHtml,
    summaryMd: actor.summaryMd,
    inboxUrl: actor.inboxUrl,
    sharedInboxUrl: actor.sharedInboxUrl,
    outboxUrl: actor.outboxUrl,
    followersUrl: actor.followersUrl,
    featuredUrl: actor.featuredUrl,
    moderatorsUrl: actor.moderatorsUrl,
    iconUrl: actor.iconUrl,
    bannerUrl: actor.bannerUrl,
    sensitive: actor.sensitive,
    bot: actor.bot,
    postingRestrictedToMods: actor.postingRestrictedToMods,
    publishedAt: iso(actor.publishedAt),
    updatedAt: iso(actor.updatedAt),
  }));

  const depth = (row: CommentRow) => row.path.split('.').length;
  return {
    set: {
      name: 'lab-live',
      description:
        'Lemmy 0.19.21, PieFed 1.8.11 and the Phase 0 spike (feddit.lab.test) in the Docker lab: the federation corpus (packages/federation/src/test/fixtures/manifest.json) replayed in capture order',
      suggestedLocalDomain: 'feddit.lab.test',
      instances,
      actors: actorRows.sort(byId),
      posts: posts.sort(byId),
      comments: comments.sort((a, b) => depth(a) - depth(b) || byId(a, b)),
      votes: votes.sort(byId),
      follows: follows.sort(byId),
    },
    dropped,
  };
}
