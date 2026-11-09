// Mbin 1.11 (/api, OAuth2). Mbin calls a community a magazine and a post an entry. Its API users
// are bots made by client_credentials clients (mbin-clients.ts). What the API cannot do goes
// through the console from `make` (lab/mbin/seed.sh); the rest is NotApplicable.
//
// Federation actions map like this (confirmed against the inbox, see INTEROP.md):
//   votePost(+1)   favourite -> Like        (a toggle; this method sets it)
//   votePost(-1)   downvote  -> Dislike
//   boostPost()    upvote    -> Announce of a bare IRI by the user (peblish: announce.bare_iri)
import { http, MBIN, NotApplicable } from '../lab.ts';
import { mbinToken } from '../mbin-clients.ts';
import type { Peer, PeerComment, PeerPost, Subscription } from './types.ts';

type UserWire = { username: string; apId: string | null; apProfileId: string | null };
type MagazineWire = { magazineId: number; name: string; isUserSubscribed: boolean; apId: string | null; apProfileId: string | null };
type EntryWire = {
  entryId: number;
  magazine: MagazineWire;
  user: UserWire;
  title: string;
  url: string | null;
  body: string | null;
  uv: number;
  dv: number;
  favourites: number;
  isFavourited: boolean;
  userVote: number;
  isPinned: boolean;
  isLocked: boolean;
  visibility: string;
  apId: string | null;
};
type CommentWire = {
  commentId: number;
  entryId: number;
  parentId: number | null;
  user: UserWire;
  magazine: MagazineWire;
  body: string | null;
  visibility: string;
  apId: string | null;
  userVote: number;
};

const host = new URL(MBIN).host;
const api = `${MBIN}/api`;

/** A local user is `https://mbin.lab.test/u/<name>`; a remote one carries `apProfileId`. */
const userUri = (user: UserWire) => user.apProfileId ?? `${MBIN}/u/${user.username}`;
/** The community's name on this instance (`lab`, or `lab@peblish.lab.test` for a remote one). */
const magazineName = (m: MagazineWire) => m.name;

/** The object's ActivityPub id: remote objects carry it; local ones are minted from the magazine and the id. */
const entryApId = (e: EntryWire) => e.apId ?? `${MBIN}/m/${magazineName(e.magazine)}/t/${e.entryId}`;
const commentApId = (c: CommentWire) => c.apId ?? `${MBIN}/m/${magazineName(c.magazine)}/t/${c.entryId}/-/comment/${c.commentId}`;

const toPost = (e: EntryWire): PeerPost => ({
  id: e.entryId,
  apId: entryApId(e),
  title: e.title,
  body: e.body,
  url: e.url,
  creatorApId: userUri(e.user),
  score: e.uv - e.dv,
  deleted: e.visibility === 'soft_deleted' || e.visibility === 'private',
  removed: e.visibility === 'trashed',
  locked: e.isLocked,
  featured: e.isPinned,
});

const toComment = (c: CommentWire): PeerComment => ({
  id: c.commentId,
  apId: commentApId(c),
  content: c.body ?? '',
  path: String(c.commentId),
  parentId: c.parentId,
  creatorApId: userUri(c.user),
  deleted: c.visibility === 'soft_deleted' || c.visibility === 'private',
  removed: c.visibility === 'trashed',
});

async function allComments(token: string, entryId: number): Promise<CommentWire[]> {
  const { items } = await http<{ items: CommentWire[] }>('GET', `${api}/entry/${entryId}/comments`, {
    token,
    query: { d: 20, perPage: 50 },
  });
  const flat: CommentWire[] = [];
  const walk = (list: (CommentWire & { children?: CommentWire[] })[]) => {
    for (const c of list) {
      flat.push(c);
      if (c.children?.length) walk(c.children);
    }
  };
  walk(items);
  return flat;
}

/** Entry by id; a trashed or deleted entry still answers for a moderator or its author. */
const getEntry = (token: string, id: number) => http<EntryWire>('GET', `${api}/entry/${id}`, { token });

export const mbin: Peer = {
  name: 'mbin',
  origin: MBIN,
  user: 'mbinuser',
  admin: 'mbinadmin',
  community: 'lab',
  actorUri: (username) => `${MBIN}/u/${username}`,
  communityHandle: () => `!lab@${host}`,
  login: (username) => mbinToken(username),
  async resolveCommunity(token, handle) {
    const [name, domain] = handle.replace(/^!/, '').split('@');
    if (domain === host) {
      const m = await http<MagazineWire>('GET', `${api}/magazine/name/${name}`, { token });
      return { id: m.magazineId, subscribed: m.isUserSubscribed ? 'Subscribed' : 'NotSubscribed' };
    }
    // Mbin's federated search fetches and stores the remote magazine.
    const { apActors } = await http<{ apActors: { type: string; object: MagazineWire }[] }>('GET', `${api}/search`, {
      token,
      query: { q: handle.startsWith('!') ? handle : `!${handle}` },
    });
    const found = apActors.find((a) => a.type === 'magazine');
    if (!found) throw new Error(`mbin could not resolve ${handle}`);
    const subscribed: Subscription = found.object.isUserSubscribed ? 'Subscribed' : 'NotSubscribed';
    return { id: found.object.magazineId, subscribed };
  },
  async follow(token, communityId) {
    const m = await http<MagazineWire>('PUT', `${api}/magazine/${communityId}/subscribe`, { token });
    return m.isUserSubscribed ? 'Subscribed' : 'Pending';
  },
  async unfollow(token, communityId) {
    const m = await http<MagazineWire>('PUT', `${api}/magazine/${communityId}/unsubscribe`, { token });
    return m.isUserSubscribed ? 'Subscribed' : 'NotSubscribed';
  },
  async createCommunity(token, name, title) {
    const m = await http<MagazineWire>('POST', `${api}/moderate/magazine/new`, {
      token,
      body: { name, title, isAdult: false, isPostingRestrictedToMods: false },
    });
    return m.magazineId;
  },
  async listPosts(token, communityId) {
    const { items } = await http<{ items: EntryWire[] }>('GET', `${api}/magazine/${communityId}/entries`, {
      token,
      query: { sort: 'newest', perPage: 50 },
    });
    return items.map(toPost);
  },
  async getPost(token, postId) {
    return toPost(await getEntry(token, postId));
  },
  async resolvePost(token, apId) {
    const { apObjects } = await http<{ apObjects: { type: string; object: EntryWire }[] }>('GET', `${api}/search`, {
      token,
      query: { q: apId },
    });
    const found = apObjects.find((o) => o.type === 'entry');
    return found ? toPost(found.object) : null;
  },
  async createPost(token, communityId, title, body, { url, nsfw = false } = {}) {
    const fields = { title, body, tags: [], isOc: false, lang: 'en', isAdult: nsfw };
    const entry = url
      ? await http<EntryWire>('POST', `${api}/magazine/${communityId}/link`, { token, body: { ...fields, url } })
      : await http<EntryWire>('POST', `${api}/magazine/${communityId}/article`, { token, body: fields });
    return toPost(entry);
  },
  async editPost(token, postId, title, body) {
    await http('PUT', `${api}/entry/${postId}`, { token, body: { title, body, tags: [], isOc: false, lang: 'en', isAdult: false } });
  },
  async deletePost(token, postId) {
    await http('DELETE', `${api}/entry/${postId}`, { token });
  },
  async listComments(token, postId) {
    return (await allComments(token, postId)).map(toComment);
  },
  async comment(token, postId, parentId, content) {
    const path = parentId ? `${api}/entry/${postId}/comments/${parentId}/reply` : `${api}/entry/${postId}/comments`;
    return toComment(await http<CommentWire>('POST', path, { token, body: { body: content, lang: 'en' } }));
  },
  async editComment(token, commentId, content) {
    await http('PUT', `${api}/comments/${commentId}`, { token, body: { body: content, lang: 'en' } });
  },
  async deleteComment(token, commentId) {
    await http('DELETE', `${api}/comments/${commentId}`, { token });
  },
  async votePost(token, postId, score) {
    const entry = await getEntry(token, postId);
    if (score === -1) {
      await http('PUT', `${api}/entry/${postId}/vote/-1`, { token });
      return;
    }
    // +1 is a favourite (Like); 0 clears whichever of the two is set.
    if (entry.userVote === -1 && score === 0) await http('PUT', `${api}/entry/${postId}/vote/0`, { token });
    if (score === 1 && !entry.isFavourited) await http('PUT', `${api}/entry/${postId}/favourite`, { token });
    if (score === 0 && entry.isFavourited) await http('PUT', `${api}/entry/${postId}/favourite`, { token });
  },
  async voteComment(token, commentId, score) {
    if (score === -1) await http('PUT', `${api}/comments/${commentId}/vote/-1`, { token });
    else if (score === 0) await http('PUT', `${api}/comments/${commentId}/vote/0`, { token });
    else await http('PUT', `${api}/comments/${commentId}/favourite`, { token });
  },
  async myPostVote(token, postId) {
    const entry = await getEntry(token, postId);
    return entry.userVote === -1 ? -1 : entry.isFavourited || entry.userVote === 1 ? 1 : 0;
  },
  async editCommunity(token, communityId, title, description) {
    await http('PUT', `${api}/moderate/magazine/${communityId}`, {
      token,
      body: { name: 'lab', title, description, isAdult: false, isPostingRestrictedToMods: false },
    });
  },
  async deleteAccount() {
    // The console does it (`mbin:user:delete <name>`), which the runner cannot reach; the lab
    // Makefile runs it between the two halves of S2 (see scenarios/accounts.ts).
    throw new NotApplicable('Mbin account deletion is a console command, run from make');
  },
  mod: {
    async resolvePerson(token, actorUri) {
      const { apActors } = await http<{ apActors: { type: string; object: { userId: number } }[] }>('GET', `${api}/search`, {
        token,
        query: { q: actorUri },
      });
      const found = apActors.find((a) => a.type === 'user');
      if (!found) throw new Error(`mbin could not resolve ${actorUri}`);
      return found.object.userId;
    },
    async removePost(token, postId, removed) {
      await http('PUT', `${api}/moderate/entry/${postId}/${removed ? 'trash' : 'restore'}`, { token });
    },
    async lockPost(token, postId, locked) {
      const entry = await getEntry(token, postId);
      if (entry.isLocked !== locked) await http('PUT', `${api}/moderate/entry/${postId}/lock`, { token });
    },
    async featurePost(token, postId, featured) {
      const entry = await getEntry(token, postId);
      if (entry.isPinned !== featured) await http('PUT', `${api}/moderate/entry/${postId}/pin`, { token });
    },
    async ban(token, communityId, personId, ban, reason) {
      if (ban) await http('POST', `${api}/moderate/magazine/${communityId}/ban/${personId}`, { token, body: { reason } });
      else await http('DELETE', `${api}/moderate/magazine/${communityId}/ban/${personId}`, { token });
    },
    async reportPost(token, postId, reason) {
      await http('POST', `${api}/entry/${postId}/report`, { token, body: { reason } });
    },
    async moderators(token, communityId) {
      const m = await http<{ moderators: { apId: string | null; username: string }[] }>('GET', `${api}/magazine/${communityId}`, { token });
      return m.moderators.map((u) => (u.apId ? `https://${u.apId.split('@')[1]}/u/${u.apId.split('@')[0]}` : `${MBIN}/u/${u.username}`));
    },
    async addModerator(token, communityId, personId, add) {
      if (add) await http('POST', `${api}/moderate/magazine/${communityId}/mod/${personId}`, { token });
      else await http('DELETE', `${api}/moderate/magazine/${communityId}/mod/${personId}`, { token });
    },
  },
};

/** The upvote (a boost on the wire). Not part of the shared Peer type: only Mbin has two positive votes. */
export async function boostPost(token: string, postId: number): Promise<void> {
  await http('PUT', `${api}/entry/${postId}/vote/1`, { token });
}
