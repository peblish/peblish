import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The staff pages' pieces (SectionTabs, the admin tabs; RailLinks, the report queue's communities and the
// modlog's filters) through the shared state helper: every state in light and dark, under forced colours
// and reduced motion and at a phone's width, where each tab and each place is a 44px target.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

for (const composition of ['section-tabs', 'rail-links']) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const states = ['rest', 'selected', 'hover', 'focus', 'pressed'];
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target: 44 })).toEqual([]);
  });
}
