import type { ActorRef } from '@peblish/schema/views';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

// The first paint, as a browser without scripts (or before hydration) gets it: no router, no
// loader data, so the hooks the panels use are stubbed.
vi.mock('../../../i18n/use-translate.ts', () => ({ useTranslate: () => ({ locale: 'en', t: (_area: string, key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: async () => {} }),
  useRouterState: ({ select }: { select: (state: { location: { searchStr: string } }) => string }) =>
    select({ location: { searchStr: '' } }),
}));
vi.mock('../-counts.ts', () => ({ loadBanCounts: async () => ({ posts: 0, comments: 0 }) }));

const { ProfileModerateTools } = await import('./content-moderate.tsx');

const actor = (name: string, kind: 'Person' | 'Group', n: number): ActorRef => ({
  id: `00000000-0000-7000-8000-00000000000${n}`,
  apId: `https://feddit.test/${name}`,
  kind,
  name,
  displayName: null,
  local: true,
  handle: name,
});

test('a profile ban with several moderated communities posts the community chosen in the native select', () => {
  const [technik, art] = [actor('technik', 'Group', 1), actor('art', 'Group', 2)];
  const html = renderToStaticMarkup(
    <ProfileModerateTools
      person={actor('tobi', 'Person', 3)}
      viewer={{ actorId: actor('mira', 'Person', 4).id, moderator: true, admin: false }}
      moderatedCommunities={[technik, art]}
      back="/u/tobi"
    />,
  );
  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';
  // The select is the form's only `community` field, so whichever one is chosen is what is sent.
  expect(form.match(/name="community"/g)).toHaveLength(1);
  expect(form).toMatch(/<select[^>]*name="community"/);
  expect(form).not.toMatch(/type="hidden" name="community"/);
});
