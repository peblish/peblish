// `make scenarios [PEERS="lemmy piefed"]`, or node scenarios/run.ts lemmy --only=S1,S2
// Drives Lemmy's /api/v3, PieFed's /api/alpha and Feddit's /spike surface and
// asserts on what each side ends up storing. Writes captures/results.json.
import {
  FEDDIT,
  feddit,
  type FedditState,
  HttpError,
  type Peer,
  type PeerComment,
  PEERS,
  recorder,
  runId,
  waitFor,
} from "./lib.ts";

const args = process.argv.slice(2);
const peers: Peer[] = args.filter((a): a is keyof typeof PEERS => a in PEERS).map((name) => PEERS[name]);
if (peers.length === 0) peers.push(PEERS.lemmy, PEERS.piefed);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
const { scenario, finish } = recorder(only);

const RUN = runId();
const COMMUNITY_HANDLE = "!spike@feddit.lab.test";
// A fresh author per run: PieFed lets an account it first saw under 24 h ago
// create only a few posts (can_create_post), even in a community hosted here.
const AUTHOR = `t${RUN}`;
const AUTHOR_URI = `${FEDDIT}/ap/u.${AUTHOR}`;
const LINK_TARGET = `${FEDDIT}/link-target`;

const state = () => feddit.state();
const findObject = (s: FedditState, uri: string) => s.objects.find((o) => o.uri === uri);
const actorOf = (peer: Peer) => `${peer.origin}/u/${peer.user}`;

interface PeerContext {
  peer: Peer;
  token: string;
  communityId: number;
  postUri?: string;
  peerPostId?: number;
  seedCommentUri?: string;
  peerComment?: PeerComment;
  replyUri?: string;
  /** The S8 post: its id on this peer and on the other peer. */
  crossPost?: { id: number; apId: string; otherId?: number };
}

await feddit.call("actors", { kind: "Person", name: AUTHOR, displayName: `Tester ${RUN}` });
const contexts: PeerContext[] = [];
for (const peer of peers) {
  contexts.push({ peer, token: await peer.login(peer.user), communityId: 0 });
}

// ---------------------------------------------------------------- S1 follow

for (const ctx of contexts) {
  const { peer, token } = ctx;
  await scenario("S1", peer.name, async () => {
    const resolved = await peer.resolveCommunity(token, COMMUNITY_HANDLE);
    ctx.communityId = resolved.id;
    const initial = await peer.follow(token, resolved.id);
    const subscribed = await waitFor("peer shows Subscribed", async () => {
      const now = await peer.resolveCommunity(token, COMMUNITY_HANDLE);
      return now.subscribed === "Subscribed" && now.subscribed;
    });
    await waitFor("Feddit stored the follower", async () =>
      (await state()).followers.some((f) => f.local_identifier === "c.spike" && f.actor_uri === actorOf(peer)));
    return `follow returned ${initial}, then ${subscribed}; Accept delivered`;
  });
}

// ---------------------------------------------------------------- S2 to S7, per peer

for (const ctx of contexts) {
  const { peer, token } = ctx;

  await scenario("S2", peer.name, async () => {
    const title = `S2 ${peer.name} ${RUN}`;
    const post = await feddit.call("post", {
      author: AUTHOR,
      community: "spike",
      title,
      body: "Hello from **Feddit**. This is a text post.",
    });
    ctx.postUri = post.uri;
    // A Feddit comment for S4's downvote.
    const seed = await feddit.call("comment", { author: "bob", inReplyTo: post.uri, body: "Seed comment from Feddit" });
    ctx.seedCommentUri = seed.uri;
    const seen = await waitFor("post in the peer's community feed", async () =>
      (await peer.listPosts(token, ctx.communityId)).find((p) => p.apId === post.uri));
    ctx.peerPostId = seen.id;
    if (seen.title !== title) throw new Error(`title ${JSON.stringify(seen.title)}`);
    if (!seen.body?.includes("Hello from **Feddit**")) throw new Error(`body ${JSON.stringify(seen.body)}`);
    if (seen.creatorApId !== AUTHOR_URI) throw new Error(`creator ${seen.creatorApId}`);
    return `post ${seen.id}: title, markdown body and author match`;
  });
  if (!ctx.peerPostId) continue;

  await scenario("S3", peer.name, async () => {
    const comment = await peer.comment(token, ctx.peerPostId!, null, `S3 comment from ${peer.name} ${RUN}`);
    ctx.peerComment = comment;
    const stored = await waitFor("comment stored in Feddit", async () => findObject(await state(), comment.apId));
    if (stored.in_reply_to !== ctx.postUri) throw new Error(`inReplyTo ${stored.in_reply_to}`);
    if (stored.author_uri !== actorOf(peer)) throw new Error(`author ${stored.author_uri}`);
    return `Note stored via ${stored.via}, inReplyTo the post`;
  });

  await scenario("S4", peer.name, async () => {
    const before = Math.max(0, ...(await state()).inbox.map((e) => Number(e.id)));
    const seed = await waitFor("seed comment on the peer", async () =>
      (await peer.listComments(token, ctx.peerPostId!)).find((c) => c.apId === ctx.seedCommentUri));
    await peer.votePost(token, ctx.peerPostId!, 1);
    await peer.voteComment(token, seed.id, -1);
    const voter = actorOf(peer);
    await waitFor("Like and Dislike stored", async () => {
      const votes = (await state()).votes;
      return votes.some((v) => v.voter_uri === voter && v.object_uri === ctx.postUri && v.kind === "Like") &&
        votes.some((v) => v.voter_uri === voter && v.object_uri === ctx.seedCommentUri && v.kind === "Dislike");
    });
    await peer.votePost(token, ctx.peerPostId!, 0);
    await peer.voteComment(token, seed.id, 0);
    await waitFor("both votes retracted", async () =>
      !(await state()).votes.some((v) => v.voter_uri === voter && (v.object_uri === ctx.postUri || v.object_uri === ctx.seedCommentUri)));
    const undos = (await state()).inbox.filter((e) =>
      Number(e.id) > before && e.type === "Undo" && e.actor === voter && e.outcome.startsWith("removed"));
    return `Like + Dislike arrived, then ${undos.length} Undo removed them`;
  });

  await scenario("S5", peer.name, async () => {
    if (!ctx.peerComment) throw new Error("needs S3");
    const parent = ctx.peerComment;
    const reply = await feddit.call("comment", { author: "alice", inReplyTo: parent.apId, body: `S5 reply from Feddit ${RUN}` });
    ctx.replyUri = reply.uri;
    const seen = await waitFor("reply on the peer", async () =>
      (await peer.listComments(token, ctx.peerPostId!)).find((c) => c.apId === reply.uri));
    const path = seen.path.split(".");
    if (path.at(-2) !== String(parent.id)) throw new Error(`path ${seen.path} is not under ${parent.id}`);
    return `reply threaded under comment ${parent.id} (path ${seen.path})`;
  });

  await scenario("S6", peer.name, async () => {
    const title = `S6 edited ${peer.name} ${RUN}`;
    await feddit.call("edit", { object: ctx.postUri, title, body: "Edited body from **Feddit**." });
    const seen = await waitFor("edit on the peer", async () => {
      const post = await peer.getPost(token, ctx.peerPostId!);
      return post.body?.includes("Edited body") && post;
    });
    if (seen.title !== title) throw new Error(`title not updated: ${seen.title}`);
    return "Update(Page) applied: title and body changed";
  });

  await scenario("S7", peer.name, async () => {
    if (!ctx.replyUri) throw new Error("needs S5");
    await feddit.call("delete", { object: ctx.replyUri });
    const tombstone = await fetch(ctx.replyUri, { headers: { accept: "application/activity+json" } });
    const body = (await tombstone.json()) as { type?: string };
    if (tombstone.status !== 410 || body.type !== "Tombstone") throw new Error(`object URL served ${tombstone.status} ${body.type}`);
    await waitFor("comment removed on the peer", async () =>
      (await peer.listComments(token, ctx.peerPostId!)).find((c) => c.apId === ctx.replyUri && (c.deleted || c.removed)));
    return "Delete applied; object URL serves 410 Tombstone";
  });
}

// ---------------------------------------------------------------- S8 cross-peer relay

for (const ctx of contexts) {
  const other = contexts.find((o) => o !== ctx);
  await scenario("S8", ctx.peer.name, async () => {
    if (!ctx.communityId) throw new Error("needs S1");
    const title = `S8 from ${ctx.peer.name} ${RUN}`;
    const created = await ctx.peer.createPost(ctx.token, ctx.communityId, title, `Posted into the Feddit community from ${ctx.peer.name}.`);
    ctx.crossPost = created;
    const stored = await waitFor("Feddit stored the post", async () => findObject(await state(), created.apId));
    if (stored.community_uri !== `${FEDDIT}/ap/c.spike`) throw new Error(`community ${stored.community_uri}`);
    const announced = (await state()).inbox.some((e) => e.object === created.apId && e.outcome.includes("announced"));
    if (!announced) throw new Error("Feddit did not Announce it");
    if (!other) return "stored and announced (no second peer in this run)";
    const relayed = await waitFor(`${other.peer.name} received it`, async () =>
      (await other.peer.listPosts(other.token, other.communityId)).find((p) => p.apId === created.apId));
    ctx.crossPost.otherId = relayed.id;
    return `stored, announced, and shown on ${other.peer.name} as post ${relayed.id} by ${relayed.creatorApId}`;
  });
}

// ---------------------------------------------------------------- S8b peer edits and deletes in Feddit's community
for (const ctx of contexts) {
  const other = contexts.find((o) => o !== ctx);
  await scenario("S8b", ctx.peer.name, async () => {
    const post = ctx.crossPost;
    if (!post) throw new Error("needs S8");
    const title = `S8b edited ${ctx.peer.name} ${RUN}`;
    await ctx.peer.editPost(ctx.token, post.id, title, "Edited inside the Feddit community.");
    await waitFor("edit stored on Feddit", async () =>
      findObject(await state(), post.apId)?.content_html.includes("Edited inside the Feddit community"));
    if (other && post.otherId) {
      await waitFor(`edit relayed to ${other.peer.name}`, async () =>
        (await other.peer.getPost(other.token, post.otherId!)).title === title);
    }
    await ctx.peer.deletePost(ctx.token, post.id);
    await waitFor("delete stored on Feddit", async () => findObject(await state(), post.apId)?.deleted);
    if (other && post.otherId) {
      await waitFor(`delete relayed to ${other.peer.name}`, async () => {
        try {
          return (await other.peer.getPost(other.token, post.otherId!)).deleted;
        } catch (error) {
          // Once deleted, Lemmy hides the post (400 couldnt_find_post) and PieFed may 404.
          if (error instanceof HttpError && (error.status === 404 || error.body.includes("couldnt_find_post"))) return true;
          throw error;
        }
      });
    }
    return `Update and Delete arrived direct, applied${other ? ` and relayed to ${other.peer.name}` : ""}`;
  });
}

// ---------------------------------------------------------------- S9 link post

for (const ctx of contexts) {
  const { peer, token } = ctx;
  await scenario("S9", peer.name, async () => {
    if (!ctx.communityId) throw new Error("needs S1");
    const link = `${LINK_TARGET}?run=${RUN}&peer=${peer.name}`;
    const post = await feddit.call("post", {
      author: "alice",
      community: "spike",
      title: `S9 link ${peer.name} ${RUN}`,
      body: "A link post.",
      link,
    });
    const seen = await waitFor("link post on the peer", async () =>
      (await peer.listPosts(token, ctx.communityId)).find((p) => p.apId === post.uri));
    if (seen.url !== link) throw new Error(`url ${JSON.stringify(seen.url)}`);
    return `post ${seen.id} has url ${seen.url}`;
  });
}

// ---------------------------------------------------------------- R: the reverse direction

for (const ctx of contexts) {
  const { peer, token } = ctx;
  const handle = `!${peer.name === "lemmy" ? "lab" : "pflab"}@${new URL(peer.origin).host}`;
  let remoteCommunityId = 0;
  let remotePost: { id: number; apId: string } | undefined;
  let remoteComment: PeerComment | undefined;
  let fedditComment: string | undefined;

  const followed = await scenario("R1", peer.name, async () => {
    const result = await feddit.call<{ remote: string; activity: string }>("follow", { follower: AUTHOR, target: handle });
    // This follower's row, accepted for this very Follow (not any subscription to the community).
    await waitFor("Accept of this Follow", async () =>
      (await state()).following.some((f) =>
        f.local_identifier === `u.${AUTHOR}` && f.remote_uri === result.remote && f.follow_id === result.activity && f.accepted));
    remoteCommunityId = (await peer.resolveCommunity(token, handle)).id;
    return `${AUTHOR} follows ${handle}; Accept matched Follow ${result.activity}`;
  });
  if (!followed) continue;

  await scenario("R2", peer.name, async () => {
    const created = await peer.createPost(token, remoteCommunityId, `R2 ${peer.name} ${RUN}`, "Native post on the peer.");
    remotePost = created;
    const stored = await waitFor("post relayed to Feddit", async () => findObject(await state(), created.apId));
    if (stored.via !== "announce") throw new Error(`arrived via ${stored.via}`);
    remoteComment = await peer.comment(token, created.id, null, `R2 native comment ${RUN}`);
    const note = await waitFor("comment relayed to Feddit", async () => findObject(await state(), remoteComment!.apId));
    return `Announce(Create(Page)) and Announce(Create(Note)) unwrapped (${stored.via}, ${note.via})`;
  });
  if (!remotePost) continue;

  await scenario("R3", peer.name, async () => {
    const reply = await feddit.call("comment", { author: AUTHOR, inReplyTo: remotePost!.apId, body: `R3 Feddit comment ${RUN}` });
    const seen = await waitFor("Feddit comment on the peer", async () =>
      (await peer.listComments(token, remotePost!.id)).find((c) => c.apId === reply.uri));
    fedditComment = reply.uri;
    const before = (await peer.getPost(token, remotePost!.id)).score;
    await feddit.call("vote", { voter: AUTHOR, object: remotePost!.apId, kind: "Like" });
    const liked = await waitFor("score +1 on the peer", async () => {
      const score = (await peer.getPost(token, remotePost!.id)).score;
      return score === before + 1 && score;
    });
    await feddit.call("vote", { voter: AUTHOR, object: remotePost!.apId, kind: "Undo" });
    await waitFor("score restored on the peer", async () => (await peer.getPost(token, remotePost!.id)).score === before);
    return `Create(Note) to remote community shown (comment ${seen.id}); Like moved score ${before} to ${liked}; Undo restored it`;
  });

  await scenario("R4", peer.name, async () => {
    await peer.editPost(token, remotePost!.id, `R4 edited ${peer.name} ${RUN}`, "Edited on the peer.");
    await waitFor("edit relayed to Feddit", async () =>
      findObject(await state(), remotePost!.apId)?.content_html.includes("Edited on the peer"));
    if (!remoteComment) throw new Error("needs R2 comment");
    await peer.deleteComment(token, remoteComment.id);
    await waitFor("delete relayed to Feddit", async () => findObject(await state(), remoteComment!.apId)?.deleted);
    return "Announce(Update(Page)) and Announce(Delete(Note)) applied";
  });
  // Feddit's own comment in the peer's community: Update and Delete sent to the remote Group.
  await scenario("R5", peer.name, async () => {
    if (!fedditComment) throw new Error("needs R3");
    const find = async () => (await peer.listComments(token, remotePost!.id)).find((c) => c.apId === fedditComment);
    await feddit.call("edit", { object: fedditComment, body: `R5 edited on Feddit ${RUN}` });
    await waitFor("edit on the peer", async () => (await find())?.content.includes("R5 edited on Feddit"));
    await feddit.call("delete", { object: fedditComment });
    await waitFor("delete on the peer", async () => {
      const comment = await find();
      return comment && (comment.deleted || comment.removed);
    });
    return "Update(Note) and Delete sent to the remote community, both applied";
  });
  // A Feddit-authored post in the peer's community: Create, Update, Delete of a Page.
  await scenario("R6", peer.name, async () => {
    const title = `R6 Feddit post in ${handle} ${RUN}`;
    const created = await feddit.call("post", { author: AUTHOR, community: handle, title, body: "Posted from **Feddit** into a remote community." });
    const seen = await waitFor("Feddit post in the peer's community", async () =>
      (await peer.listPosts(token, remoteCommunityId)).find((p) => p.apId === created.uri));
    if (seen.title !== title) throw new Error(`title ${JSON.stringify(seen.title)}`);
    if (!seen.body?.includes("Posted from **Feddit**")) throw new Error(`body ${JSON.stringify(seen.body)}`);
    if (seen.creatorApId !== AUTHOR_URI) throw new Error(`creator ${seen.creatorApId}`);
    const editedTitle = `R6 edited ${RUN}`;
    await feddit.call("edit", { object: created.uri, title: editedTitle, body: "Edited on **Feddit**." });
    await waitFor("edit on the peer", async () => {
      const post = await peer.getPost(token, seen.id);
      return post.title === editedTitle && post.body?.includes("Edited on **Feddit**");
    });
    await feddit.call("delete", { object: created.uri });
    await waitFor("delete on the peer", async () => {
      try {
        return (await peer.getPost(token, seen.id)).deleted;
      } catch (error) {
        // Once deleted, Lemmy hides the post (400 couldnt_find_post) and PieFed may 404.
        if (error instanceof HttpError && (error.status === 404 || error.body.includes("couldnt_find_post"))) return true;
        throw error;
      }
    });
    return `Create(Page) by ${AUTHOR} shown as post ${seen.id} (title, markdown body, author match); Update and Delete applied`;
  });
}

finish("results.json", RUN);
