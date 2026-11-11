import { closePools } from '../../packages/core/src/db/pools.ts';
import { seedPost } from '../../packages/core/src/testing/seed-az.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// Remote names as other servers send them, for the feed's layout and bidi checks, on the lane
// database (DATABASE_URL from scripts/lane.sh): `node e2e/feeds/seed-names.ts` prints them as
// JSON, on fresh names every run. Specs find the posts by title, on /all?sort=new.
// - `long`: a link post with a long title, whose community and author have long names on a long
//   host, and whose link is on that long host;
// - `title`: a link post with the same long title, on an ordinary domain;
// - `hostile`: a post whose author's name carries a right-to-left override and an isolate, on an
//   ordinary host, to show that the name cannot move or reverse the host.
// Escapes only: this file holds no control character.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const far = await seedInstance(`a-very-long-subdomain-${suffix}.some-instance.example`, false);
  const community = await seedActor(far, 'Group', `a_very_long_community_name_from_elsewhere_${suffix}`);
  const author = await seedActor(far, 'Person', `a_very_long_account_name_${suffix}`);
  const longTitle = `Long names ${suffix} and a title long enough to need more than one line on every screen, so that it must be cut short somewhere`;
  const long = await seedPost(far, community, author, {
    title: longTitle,
    url: `https://${far.domain}/a/long/article`,
    publishedAt: new Date(Date.now() - 2_000),
  });
  const titled = await seedPost(far, community, author, {
    title: longTitle.replace('Long names', 'Long title'),
    url: `https://news-${suffix}.example/a/long/article`,
    publishedAt: new Date(Date.now() - 1_500),
  });
  const honest = await seedInstance(`honest-${suffix}.example`, false);
  const hostileName = `jun‮⁦moc.elpmaxe_${suffix}`;
  const hostileAuthor = await seedActor(honest, 'Person', hostileName);
  const hostileCommunity = await seedActor(honest, 'Group', `plain_${suffix}`);
  const hostile = await seedPost(honest, hostileCommunity, hostileAuthor, {
    title: `Hostile name ${suffix}`,
    publishedAt: new Date(Date.now() - 1_000),
  });
  console.log(
    JSON.stringify({
      suffix,
      long: { id: long.id, title: longTitle, host: far.domain, community: community.name, author: author.name },
      title: { id: titled.id, domain: `news-${suffix}.example` },
      hostile: { id: hostile.id, title: `Hostile name ${suffix}`, host: honest.domain, author: hostileName },
    }),
  );
} finally {
  await closePools();
}
