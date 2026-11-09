import { randomBytes } from 'node:crypto';
import { newObjectApId } from '@peblish/schema/actor-urls';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { mediaProxyKey, proxyUrlBuilder } from '../media/proxy-url.ts';
import { seedSetting } from './seed-a.ts';
import { seedActor } from './seed.ts';

// Lane B2's seeds for the e2e specs, on the lane database (DATABASE_URL from scripts/lane.sh):
//   node packages/core/src/testing/seed-b2.ts proxy-path <remote url>
//   node packages/core/src/testing/seed-b2.ts remote-media <true|false>
//   node packages/core/src/testing/seed-b2.ts remote-image-post <remote image url>
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

if (import.meta.main) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'proxy-path' && value) console.log(JSON.stringify(await proxyPath(value)));
    else if (command === 'remote-media' && (value === 'true' || value === 'false')) {
      await seedSetting('remote_media.enabled', value === 'true');
      console.log(JSON.stringify(value === 'true'));
    } else if (command === 'remote-image-post' && value) console.log(JSON.stringify(await seedRemoteImagePost(value)));
    else
      throw new Error(
        'usage: node packages/core/src/testing/seed-b2.ts proxy-path <url> | remote-media <true|false> | remote-image-post <url>',
      );
  } finally {
    await closePools();
  }
}
