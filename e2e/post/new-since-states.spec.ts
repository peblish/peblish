import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// "New since your last visit" on its gallery state page (packages/web/src/routes/kit/-visits.tsx), through the
// shared state helper: the jump and the marked comments at rest, hovered, focused and pressed, and the count whose new
// comments are on other pages (disabled), in light and dark, under forced colours and reduced motion and at a
// phone's width, with axe and the 44 px targets. The journeys are in new-since.spec.ts.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(180_000);

test('/kit/new-since: every state, scheme and condition passes', async ({ browser, baseURL }) => {
  const states = ['rest', 'disabled', 'hover', 'focus', 'pressed'];
  const checks = await galleryStates(browser, baseURL!, '/kit/new-since');
  expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
  expect(checks).toHaveLength(states.length * 2 * 4);
  expect(stateProblems(checks)).toEqual([]);
});
