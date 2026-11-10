import { randomBytes } from 'node:crypto';
import { newObjectApId } from '@peblish/schema/actor-urls';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { mediaProxyKey, proxyUrlBuilder } from '../media/proxy-url.ts';
import { peerControls } from '../peers/tables.ts';
import { PASSWORD, seedAccount, seedSetting } from './seed-a.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane B2's seeds for the e2e specs, on the lane database (DATABASE_URL from scripts/lane.sh):
//   node packages/core/src/testing/seed-b2.ts proxy-path <remote url>
//   node packages/core/src/testing/seed-b2.ts remote-media <true|false>
//   node packages/core/src/testing/seed-b2.ts remote-image-post <remote image url>
//   node packages/core/src/testing/seed-b2.ts sensitive-thumbnail-post <remote image url>
// Each prints one JSON value. Test code only.

/** The signed /media/proxy path the instance would put in a page for `url`. */
export async function proxyPath(url: string): Promise<string> {
  return proxyUrlBuilder(await mediaProxyKey())(url);
}

/** A local post in a new community whose body shows a remote image; names are unique per call. */
export async function seedRemoteImagePost(imageUrl: string) {
  const instance = await localInstance(db());
  const local = { id: instance.id, domain: new URL(instance.origin).host, local: true };
  const suffix = randomBytes(3).toString('hex');
  const author = await seedActor(local, 'Person', `b2_poster_${suffix}`);
  const community = await seedActor(local, 'Group', `b2_media_${suffix}`);
  const id = uuidv7();
  await writer()
    .insert(posts)
    .values({
      id,
      apId: newObjectApId(instance.origin, 'post', id),
      local: true,
      instanceId: instance.id,
      authorId: author.id,
      communityId: community.id,
      title: 'A post with a remote image',
      bodyMd: `Look at this:\n\n![a remote picture](${imageUrl})\n`,
      publishedAt: new Date(),
    });
  return { postId: id, community: community.name, imageUrl };
}

/**
 * A sensitive image post from a peer whose media is approved, in its remote community, with a
 * remote thumbnail; a reader with a 16+ declaration and one without. Names are unique per call.
 */
export async function seedSensitiveThumbnailPost(imageUrl: string) {
  const suffix = randomBytes(3).toString('hex');
  const remote = await seedInstance(`reveal-${suffix}.test`, false);
  await writer().insert(peerControls).values({ instanceId: remote.id, media: 'approved' });
  const author = await seedActor(remote, 'Person', `reveal_author_${suffix}`);
  const community = await seedActor(remote, 'Group', `reveal_${suffix}`);
  const id = uuidv7();
  const title = `Revealed picture ${suffix}`;
  await writer()
    .insert(posts)
    .values({
      id,
      apId: `${remote.origin}/post/${suffix}`,
      local: false,
      instanceId: remote.id,
      authorId: author.id,
      communityId: community.id,
      title,
      sensitive: true,
      url: imageUrl,
      urlContentType: 'image/png',
      thumbnailUrl: imageUrl,
      publishedAt: new Date(),
    });
  const [declared, undeclared] = await Promise.all([seedAccount(`reveal_${suffix}`), seedAccount(`reveal_minor_${suffix}`)]);
  await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, undeclared.actorId));
  return {
    postId: id,
    title,
    community: `${community.name}@${remote.domain}`,
    password: PASSWORD,
    declared: declared.name,
    undeclared: undeclared.name,
  };
}

if (import.meta.main) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'proxy-path' && value) console.log(JSON.stringify(await proxyPath(value)));
    else if (command === 'remote-media' && (value === 'true' || value === 'false')) {
      await seedSetting('remote_media.enabled', value === 'true');
      console.log(JSON.stringify(value === 'true'));
    } else if (command === 'remote-image-post' && value) console.log(JSON.stringify(await seedRemoteImagePost(value)));
    else if (command === 'sensitive-thumbnail-post' && value) console.log(JSON.stringify(await seedSensitiveThumbnailPost(value)));
    else
      throw new Error(
        'usage: node packages/core/src/testing/seed-b2.ts proxy-path <url> | remote-media <true|false> | remote-image-post <url> | sensitive-thumbnail-post <url>',
      );
  } finally {
    await closePools();
  }
}
