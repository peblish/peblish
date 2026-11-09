// The routes the payload budget covers (budget.spec.ts), each measured on a first visit with
// a cold cache. A lane that adds a page asks root to add its path here; the check then holds
// that page to the same budget.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface PayloadRoute {
  /** The route as the test names it. */
  path: string;
  /**
   * The URL to visit when the page needs seeded data (a post page): it reads the lane database,
   * so the route is skipped against a remote BASE_URL.
   */
  target?: () => string;
  /** The composer: the one route that may load the editor's lazy chunk (vendor-editor). */
  composer?: true;
  /** Renders regular, italic and code text, so it is where the font budget is measured. */
  fonts?: true;
}

/** A post page needs a post: the first one lane B1's seed (testing/seed-b1.ts) puts in the database. */
const seededPost = () => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return `/post/${(JSON.parse(out) as { posts: { plain: string } }).posts.plain}`;
};

// B2's /media/proxy is an image endpoint, not a page: it sends no markup, so it has no payload to budget.
export const routes: readonly PayloadRoute[] = [
  { path: '/' },
  { path: '/auth/sign-in' },
  { path: '/post/<id>', target: seededPost },
  { path: '/kit', fonts: true },
];
