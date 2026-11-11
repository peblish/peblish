// The pages the payload budget covers (budget.spec.ts), each measured on a first visit with a
// cold cache. A lane that adds a page asks root to add it here, or to list it under notPages
// with the reason it has no markup to budget: the inventory test in budget.spec.ts fails
// until one of the two is done, so a new page cannot slip past the budget unmeasured.
// Each page carries its own script budget (`js`): what it measured when the budget was set plus
// 5%, rounded up to 0.1 kB, stored as the number itself. PAYLOAD.md says how to re-measure and
// when to raise one.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ScriptBudget } from './budget.ts';
import { fixtures } from './fixtures.ts';

export interface PayloadRoute {
  /** The page's file route, as `FileRoutesByFullPath` in routeTree.gen.ts spells it. */
  route: string;
  /** The page as the test names it. */
  path: string;
  /**
   * The URL to visit when the page needs data from the lane database (a post, an invite code, a
   * mailed token): it is skipped against a remote BASE_URL, where there is no database to seed.
   */
  target?: (baseURL: string) => string | Promise<string>;
  /** The page is for a signed-in admin (two-factor on); the visit carries their session. Skipped against a remote BASE_URL, too. */
  admin?: true;
  /** The composer: the one route that may load the editor's lazy chunk (vendor-editor). */
  composer?: true;
  /** Renders regular, italic and code text, so it is where the font budget is measured. */
  fonts?: true;
  /** The page's React and Mux UI JavaScript budget, enforced: a first visit over it fails. */
  js: ScriptBudget;
  /** The composer only: the budget of `/submit` signed in, which e2e/composer/payload.spec.ts measures. */
  signedInJs?: ScriptBudget;
  /**
   * Text the page must show before it is measured, from data seeded on the lane database. A remote
   * BASE_URL still measures the page, without this check.
   */
  shows?: (baseURL: string) => Promise<RegExp>;
}

/** A post page needs a post: the first one lane B1's seed (testing/seed-b1.ts) puts in the database. */
const seededPost = () => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return `/post/${(JSON.parse(out) as { posts: { plain: string } }).posts.plain}`;
};

/** The permalink page needs a comment: lane D's seed (testing/seed-d.ts) puts a thread in the database. */
const seededPermalink = () => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-d.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  const { posts, comments } = JSON.parse(out) as { posts: { thread: string }; comments: { first: string } };
  return `/post/${posts.thread}/comments/${comments.first}`;
};

/** The community page and its edit form need a community: lane COMM's seed (testing/seed-comm.ts) makes one with rules, languages and posts. */
const seededCommunity = (suffix = '') => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-comm.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return `/c/${(JSON.parse(out) as { communities: { open: { handle: string } } }).communities.open.handle}${suffix}`;
};

/** The report form and its receipt need a report the payload admin filed: lane REP's seed (testing/seed-rep.ts) makes one. */
const seededReport = async (base: string) => {
  const { admin } = await fixtures(base);
  const out = execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'payload', admin.name], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as { postId: string; number: number };
};
let reported: ReturnType<typeof seededReport> | undefined;
const reportedOnce = (base: string) => (reported ??= seededReport(base));

const bidiControls = '\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C';
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The name part of a community handle as `Handle` draws it: `!` and the name, each directional
 * control replaced by one visible character (the replacement mark), never left as the control.
 * Whichever mark the app picks, the font check then measures the glyph it is drawn with.
 */
function drawnName(handle: string): RegExp {
  const name = handle.slice(0, handle.lastIndexOf('@'));
  const parts = name.split(new RegExp(`[${bidiControls}]`));
  if (parts.length < 2) throw new Error(`${JSON.stringify(handle)} has no directional control in its name`);
  return new RegExp(`^!${parts.map(escaped).join(`[^\\s${bidiControls}]`)}$`);
}

export const routes: readonly PayloadRoute[] = [
  { route: '/', path: '/', js: { budget: 192.6, measured: 183.4, on: '2026-11-12' } },
  { route: '/all/', path: '/all', js: { budget: 192.6, measured: 183.4, on: '2026-11-12' } },
  { route: '/local/', path: '/local', js: { budget: 192.6, measured: 183.4, on: '2026-11-12' } },
  { route: '/popular/', path: '/popular', js: { budget: 192.6, measured: 183.4, on: '2026-11-12' } },
  { route: '/moderating/', path: '/moderating', js: { budget: 192.6, measured: 183.4, on: '2026-11-12' } },
  // Seeded first, so the font budget always measures the replacement mark at the head of the list.
  {
    route: '/communities/',
    path: '/communities',
    js: { budget: 241.9, measured: 230.3, on: '2026-11-12' },
    shows: async (base) => drawnName((await fixtures(base)).bidiCommunity),
  },
  { route: '/resolve/', path: '/resolve', js: { budget: 194.6, measured: 185.3, on: '2026-11-12' } },
  { route: '/auth/sign-in', path: '/auth/sign-in', js: { budget: 194.6, measured: 185.3, on: '2026-11-12' } },
  { route: '/auth/sign-up', path: '/auth/sign-up', js: { budget: 196.5, measured: 187.1, on: '2026-11-12' } },
  {
    route: '/auth/sign-up',
    path: '/auth/sign-up?invite=<code>',
    js: { budget: 196.5, measured: 187.1, on: '2026-11-12' },
    target: async (base) => `/auth/sign-up?invite=${(await fixtures(base)).inviteCode}`,
  },
  { route: '/auth/reset', path: '/auth/reset', js: { budget: 194.6, measured: 185.3, on: '2026-11-12' } },
  {
    route: '/auth/reset',
    path: '/auth/reset?token=<mailed>',
    js: { budget: 194.6, measured: 185.3, on: '2026-11-12' },
    target: async (base) => (await fixtures(base)).resetPath,
  },
  { route: '/auth/two-factor', path: '/auth/two-factor', js: { budget: 194.6, measured: 185.3, on: '2026-11-12' } },
  {
    route: '/auth/verify',
    path: '/auth/verify?token=<mailed>',
    js: { budget: 194.6, measured: 185.3, on: '2026-11-12' },
    target: async (base) => (await fixtures(base)).verifyPath,
  },
  {
    route: '/auth/verify',
    path: '/auth/verify (signed in)',
    js: { budget: 194.6, measured: 185.3, on: '2026-11-12' },
    target: () => '/auth/verify',
    admin: true,
  },
  {
    route: '/invite/$code',
    path: '/invite/<code>',
    js: { budget: 194.6, measured: 185.3, on: '2026-11-12' },
    target: async (base) => `/invite/${(await fixtures(base)).inviteCode}`,
  },
  { route: '/settings/account/', path: '/settings/account', js: { budget: 194.6, measured: 185.3, on: '2026-11-12' }, admin: true },
  { route: '/settings/security/', path: '/settings/security', js: { budget: 195.5, measured: 186.1, on: '2026-11-12' }, admin: true },
  { route: '/settings/blocks/', path: '/settings/blocks', js: { budget: 212.6, measured: 202.4, on: '2026-11-12' }, admin: true },
  {
    route: '/u/$handle/',
    path: '/u/<handle>',
    js: { budget: 198.2, measured: 188.7, on: '2026-11-12' },
    target: async (base) => `/u/${(await fixtures(base)).admin.name}`,
  },
  {
    route: '/u/$handle/edit',
    path: '/u/<handle>/edit',
    js: { budget: 195.8, measured: 186.4, on: '2026-11-12' },
    target: async (base) => `/u/${(await fixtures(base)).admin.name}/edit`,
    admin: true,
  },
  { route: '/notifications/', path: '/notifications', js: { budget: 191.3, measured: 182.1, on: '2026-11-12' }, admin: true },
  { route: '/admin/registration/', path: '/admin/registration', js: { budget: 214.2, measured: 204.0, on: '2026-11-12' }, admin: true },
  { route: '/c/$handle/', path: '/c/<handle>', js: { budget: 198.5, measured: 189.0, on: '2026-11-12' }, target: () => seededCommunity() },
  { route: '/c/new', path: '/c/new', js: { budget: 197.4, measured: 188.0, on: '2026-11-12' }, admin: true },
  {
    route: '/c/$handle/edit',
    path: '/c/<handle>/edit',
    js: { budget: 197.4, measured: 188.0, on: '2026-11-12' },
    target: () => seededCommunity('/edit'),
    admin: true,
  },
  { route: '/admin/bans/', path: '/admin/bans', js: { budget: 215.2, measured: 204.9, on: '2026-11-12' }, admin: true },
  { route: '/admin/peers/', path: '/admin/peers', js: { budget: 215.2, measured: 204.9, on: '2026-11-12' }, admin: true },
  { route: '/modlog/', path: '/modlog', js: { budget: 190.5, measured: 181.4, on: '2026-11-12' } },
  { route: '/admin/reports/', path: '/admin/reports', js: { budget: 214.2, measured: 204.0, on: '2026-11-12' }, admin: true },
  { route: '/admin/settings/', path: '/admin/settings', js: { budget: 196.1, measured: 186.7, on: '2026-11-12' }, admin: true },
  { route: '/admin/pages/', path: '/admin/pages', js: { budget: 213.2, measured: 203.0, on: '2026-11-12' }, admin: true },
  {
    route: '/admin/pages/$slug/$language',
    path: '/admin/pages/<slug>/<language>',
    js: { budget: 203.7, measured: 194.0, on: '2026-11-12' },
    target: () => '/admin/pages/rules/en',
    admin: true,
  },
  { route: '/$slug', path: '/about', js: { budget: 190.5, measured: 181.4, on: '2026-11-12' }, target: () => '/about' },
  { route: '/admin/media/', path: '/admin/media', js: { budget: 222.6, measured: 212.0, on: '2026-11-12' }, admin: true },
  { route: '/post/$id/', path: '/post/<id>', js: { budget: 198.7, measured: 189.2, on: '2026-11-12' }, target: seededPost },
  {
    route: '/post/$id/comments/$commentId',
    path: '/post/<id>/comments/<commentId>',
    js: { budget: 197.7, measured: 188.2, on: '2026-11-12' },
    target: seededPermalink,
  },
  // Signed out, /submit is a redirect to sign-in, so this entry measures the sign-in page it lands on
  // and cannot show the composer's weight. The signed-in figure, with the sheet's lazy editor
  // chunk, is measured through the composer's own fixture (e2e/composer/payload.spec.ts), against signedInJs.
  {
    route: '/submit/',
    path: '/submit',
    js: { budget: 194.6, measured: 185.3, on: '2026-11-12' },
    signedInJs: { budget: 233.4, measured: 222.2, on: '2026-11-12' },
    composer: true,
  },
  {
    route: '/report/',
    path: '/report?kind=post&id=<id>',
    js: { budget: 226.6, measured: 215.8, on: '2026-11-12' },
    target: async (base) => `/report?kind=post&id=${(await reportedOnce(base)).postId}`,
    admin: true,
  },
  {
    route: '/report/sent/',
    path: '/report/sent?n=<number>',
    js: { budget: 190.5, measured: 181.4, on: '2026-11-12' },
    target: async (base) => `/report/sent?n=${(await reportedOnce(base)).number}`,
    admin: true,
  },
  // The gallery (behind PEBLISH_UI_KIT=1, a 404 in production) loads every component at once,
  // so it is no visitor's first visit.
  { route: '/kit/', path: '/kit', js: { budget: 210.7, measured: 200.6, on: '2026-11-12' }, fonts: true },
];

/** File routes that send no page, so there is no payload to budget; each says why. */
export const notPages: Readonly<Record<string, string>> = {
  '/admin': 'a layout group; /admin itself answers 404',
  '/auth': 'a layout group; /auth itself answers 404',
  '/invite': 'a layout group; /invite itself answers 404',
  '/settings': 'a layout group; /settings itself answers 404',
  '/healthz': 'a probe answering plain text',
  '/readyz': 'a probe answering plain text',
  '/auth/sign-out': 'a form post that answers with a redirect',
  '/communities/follow': 'the POST endpoint of Join and Leave; a GET answers 404',
  '/post/$id/comments/': 'the POST endpoint of the comment forms; a GET redirects to the post page',
  '/media/proxy/$signature/$target': 'an image endpoint, not a page',
  '/modlog/act': 'the POST endpoint of the moderator forms; it answers with a redirect or JSON',
  '/media/$id': 'an uploaded image endpoint, not a page',
};

/** File routes that are neither budgeted nor listed as having no payload. */
export const unaccounted = (inventory: readonly string[]) =>
  inventory.filter((route) => !routes.some((budgeted) => budgeted.route === route) && !(route in notPages));
