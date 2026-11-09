// Lemmy 0.19 (/api/v3) and PieFed 1.8 (/api/alpha). PieFed's API mirrors Lemmy's, so one factory
// serves both; `flavor` carries the few places they differ (field names, ban and delete calls).
import { http, LEMMY, NotApplicable, PASSWORD, PIEFED } from '../lab.ts';
import type { Peer, PeerComment, PeerPost, Subscription } from './types.ts';

type Flavor = 'lemmy' | 'piefed';

type PostViewWire = {
  post: {
    id: number;
    ap_id: string;
    name?: string;
    title?: string;
    body?: string | null;
    url?: string | null;
    deleted: boolean;
    removed?: boolean;
    locked?: boolean;
    featured_community?: boolean;
    sticky?: boolean;
  };
  creator: { actor_id: string };
  counts: { score: number };
  my_vote?: number;
};

type CommentViewWire = {
  comment: { id: number; ap_id: string; content?: string; body?: string; path: string; deleted: boolean; removed: boolean };
  creator: { actor_id: string };
};

const toPost = (view: PostViewWire): PeerPost => ({
  id: view.post.id,
  apId: view.post.ap_id,
  title: view.post.name ?? view.post.title ?? '',
  body: view.post.body ?? null,
  url: view.post.url ?? null,
  creatorApId: view.creator.actor_id,
  score: view.counts.score,
  deleted: view.post.deleted,
  removed: view.post.removed ?? false,
  locked: view.post.locked ?? false,
  featured: view.post.featured_community ?? view.post.sticky ?? false,
});

const toComment = (view: CommentViewWire): PeerComment => {
  const ids = view.comment.path.split('.').map(Number);
  const parent = ids.length > 2 ? (ids.at(-2) ?? null) : null;
  return {
    id: view.comment.id,
    apId: view.comment.ap_id,
    content: view.comment.content ?? view.comment.body ?? '',
    path: view.comment.path,
    parentId: parent,
    creatorApId: view.creator.actor_id,
    deleted: view.comment.deleted,
    removed: view.comment.removed,
  };
};

export type ThreadiverseOptions = {
  flavor: Flavor;
  origin: string;
  user: string;
  admin: string;
  community: string;
  /** The password every seeded account of this peer has. */
  password?: string;
};

export function threadiversePeer({ flavor, origin, user, admin, community, password = PASSWORD }: ThreadiverseOptions): Peer {
  const base = `${origin}${flavor === 'lemmy' ? '/api/v3' : '/api/alpha'}`;
  const host = new URL(origin).host;
  const lemmy = flavor === 'lemmy';

  async function setFollow(token: string, communityId: number, follow: boolean): Promise<string> {
    const { community_view } = await http<{ community_view: { subscribed: string } }>('POST', `${base}/community/follow`, {
      token,
      body: { community_id: communityId, follow },
    });
    return community_view.subscribed;
  }

  async function resolvePersonId(token: string, actorUri: string): Promise<number> {
    const { person } = await http<{ person?: { person: { id: number } } }>('GET', `${base}/resolve_object`, {
      token,
      query: { q: actorUri },
    });
    if (!person) throw new Error(`${flavor} could not resolve ${actorUri}`);
    return person.person.id;
  }

  return {
    name: flavor,
    origin,
    user,
    admin,
    community,
    actorUri: (username) => `${origin}/u/${username}`,
    communityHandle: () => `!${community}@${host}`,
    async login(username) {
      // Lemmy derives the token from a second-resolution iat: two logins of one user in the same
      // second collide on login_token_pkey. Try again a moment later.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const { jwt } = await http<{ jwt: string }>('POST', `${base}/user/login`, {
            body: lemmy ? { username_or_email: username, password } : { username, password },
          });
          return jwt;
        } catch (error) {
          if (attempt >= 3 || !String(error).includes('login_token_pkey')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1_100));
        }
      }
    },
    async resolveCommunity(token, handle) {
      const { community: found } = await http<{ community?: { community: { id: number }; subscribed: Subscription } }>(
        'GET',
        `${base}/resolve_object`,
        { token, query: { q: handle } },
      );
      if (!found) throw new Error(`${flavor} could not resolve ${handle}`);
      return { id: found.community.id, subscribed: found.subscribed };
    },
    follow: (token, communityId) => setFollow(token, communityId, true),
    unfollow: (token, communityId) => setFollow(token, communityId, false),
    async createCommunity(token, name, title) {
      const { community_view } = await http<{ community_view: { community: { id: number } } }>('POST', `${base}/community`, {
        token,
        body: { name, title },
      });
      return community_view.community.id;
    },
    async listPosts(token, communityId) {
      const { posts } = await http<{ posts: PostViewWire[] }>('GET', `${base}/post/list`, {
        token,
        query: { community_id: communityId, sort: 'New', limit: 50 },
      });
      return posts.map(toPost);
    },
    async getPost(token, postId) {
      const { post_view } = await http<{ post_view: PostViewWire }>('GET', `${base}/post`, { token, query: { id: postId } });
      return toPost(post_view);
    },
    async resolvePost(token, apId) {
      const { post } = await http<{ post?: PostViewWire }>('GET', `${base}/resolve_object`, { token, query: { q: apId } });
      return post ? toPost(post) : null;
    },
    async createPost(token, communityId, title, body, { url, nsfw } = {}) {
      const extra = { ...(url ? { url } : {}), ...(nsfw ? { nsfw: true } : {}) };
      const { post_view } = await http<{ post_view: PostViewWire }>('POST', `${base}/post`, {
        token,
        body: lemmy ? { name: title, body, community_id: communityId, ...extra } : { title, body, community_id: communityId, ...extra },
      });
      return toPost(post_view);
    },
    async editPost(token, postId, title, body) {
      await http('PUT', `${base}/post`, { token, body: lemmy ? { post_id: postId, name: title, body } : { post_id: postId, title, body } });
    },
    async deletePost(token, postId) {
      await http('POST', `${base}/post/delete`, { token, body: { post_id: postId, deleted: true } });
    },
    async listComments(token, postId) {
      const { comments } = await http<{ comments: CommentViewWire[] }>('GET', `${base}/comment/list`, {
        token,
        query: lemmy ? { post_id: postId, sort: 'New', type_: 'All', limit: 50 } : { post_id: postId, sort: 'New', limit: 50 },
      });
      return comments.map(toComment);
    },
    async comment(token, postId, parentId, content) {
      const parent = parentId ? { parent_id: parentId } : {};
      const { comment_view } = await http<{ comment_view: CommentViewWire }>('POST', `${base}/comment`, {
        token,
        body: lemmy ? { content, post_id: postId, ...parent } : { body: content, post_id: postId, ...parent },
      });
      return toComment(comment_view);
    },
    async editComment(token, commentId, content) {
      await http('PUT', `${base}/comment`, {
        token,
        body: lemmy ? { comment_id: commentId, content } : { comment_id: commentId, body: content },
      });
    },
    async deleteComment(token, commentId) {
      await http('POST', `${base}/comment/delete`, { token, body: { comment_id: commentId, deleted: true } });
    },
    async votePost(token, postId, score) {
      await http('POST', `${base}/post/like`, { token, body: { post_id: postId, score } });
    },
    async voteComment(token, commentId, score) {
      await http('POST', `${base}/comment/like`, { token, body: { comment_id: commentId, score } });
    },
    async myPostVote(token, postId) {
      const { post_view } = await http<{ post_view: PostViewWire }>('GET', `${base}/post`, { token, query: { id: postId } });
      const vote = post_view.my_vote ?? 0;
      return vote > 0 ? 1 : vote < 0 ? -1 : 0;
    },
    async communityDescription(token, communityId) {
      const { community_view } = await http<{ community_view: { community: { description?: string | null } } }>(
        'GET',
        `${base}/community`,
        {
          token,
          query: { id: communityId },
        },
      );
      return community_view.community.description ?? null;
    },
    async editCommunity(token, communityId, title, description) {
      await http('PUT', `${base}/community`, { token, body: { community_id: communityId, title, description } });
    },
    registerUser: lemmy
      ? async (username) => {
          await http('POST', `${base}/user/register`, { body: { username, password, password_verify: password, show_nsfw: false } });
          // Lemmy's JWT carries a second-resolution iat; a login in the same second collides.
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        }
      : undefined,
    async deleteAccount(token, pw, deleteContent) {
      if (!lemmy) throw new NotApplicable('PieFed deletes an account through its settings form only; the API stub does nothing');
      await http('POST', `${base}/user/delete_account`, { token, body: { password: pw, delete_content: deleteContent } });
    },
    mod: {
      resolvePerson: resolvePersonId,
      async removePost(token, postId, removed, reason) {
        await http('POST', `${base}/post/remove`, { token, body: { post_id: postId, removed, reason } });
      },
      async lockPost(token, postId, locked) {
        await http('POST', `${base}/post/lock`, { token, body: { post_id: postId, locked } });
      },
      async featurePost(token, postId, featured) {
        await http('POST', `${base}/post/feature`, { token, body: { post_id: postId, featured, feature_type: 'Community' } });
      },
      async ban(token, communityId, personId, ban, reason) {
        if (lemmy) {
          await http('POST', `${base}/community/ban_user`, {
            token,
            body: { community_id: communityId, person_id: personId, ban, reason, remove_data: false },
          });
        } else if (ban) {
          await http('POST', `${base}/community/moderate/ban`, {
            token,
            body: { community_id: communityId, user_id: personId, reason, permanent: true },
          });
        } else {
          await http('PUT', `${base}/community/moderate/unban`, { token, body: { community_id: communityId, user_id: personId } });
        }
      },
      async reportPost(token, postId, reason) {
        await http('POST', `${base}/post/report`, { token, body: { post_id: postId, reason } });
      },
      async moderators(token, communityId) {
        const { moderators } = await http<{ moderators?: { moderator: { actor_id: string } }[] }>('GET', `${base}/community`, {
          token,
          query: { id: communityId },
        });
        return (moderators ?? []).map((entry) => entry.moderator.actor_id);
      },
      async addModerator(token, communityId, personId, add) {
        await http(lemmy ? 'POST' : 'PUT', `${base}/community/mod`, {
          token,
          body: { community_id: communityId, person_id: personId, added: add },
        });
      },
    },
  };
}

export const lemmy = threadiversePeer({ flavor: 'lemmy', origin: LEMMY, user: 'lemmyuser', admin: 'lemmyadmin', community: 'lab' });
export const piefed = threadiversePeer({ flavor: 'piefed', origin: PIEFED, user: 'pfuser', admin: 'pfadmin', community: 'pflab' });
