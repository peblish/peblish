import { expect, test } from 'vitest';
import { headTitle, ownTitle } from './title.ts';

const matches = [{ routeId: '__root__', loaderData: { locale: 'en-US', shell: { siteName: 'Test Feddit' } } }];
const at = (status: string) => ({ match: { status }, matches });

test("a route's title is given only while its own match is a success: an error or a not-found leaves it to the root", () => {
  expect(ownTitle(at('success'), 'A post | !lab')).toEqual([{ title: 'A post | !lab' }]);
  expect(headTitle(at('success'), 'modlog', 'title')).toEqual([{ title: 'Modlog · Test Feddit' }]);
  for (const status of ['error', 'notFound', 'pending']) {
    // A client-side navigation keeps the match's earlier loader data, so the title is still to hand.
    expect(ownTitle(at(status), 'A post | !lab')).toEqual([]);
    expect(headTitle(at(status), 'modlog', 'title')).toEqual([]);
  }
  expect(headTitle(at('notFound'), 'communities', 'page.notFound.title', { on: 'notFound' })).toEqual([
    { title: 'Community not found · Test Feddit' },
  ]);
  expect(ownTitle(at('success'), undefined)).toEqual([]);
});
