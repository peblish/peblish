import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The frame's compositions on their gallery state pages (packages/web/src/routes/kit/-states.tsx), through the shared
// state helper: every state in light and dark, under forced colours and reduced motion and at a phone's width. The view
// header and the bottom bar are the phone's bars, held to the state matrix's 44 px targets; the edge toggle is a
// desktop control (a phone has the drawer instead), held to WCAG's 24.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(180_000);

const compositions = {
  'view-header': { states: ['rest', 'hover', 'focus', 'pressed'], target: 44 },
  'bottom-tab-bar': { states: ['rest', 'selected', 'hover', 'focus', 'pressed'], target: 44 },
  'edge-toggle': { states: ['rest', 'selected', 'hover', 'focus', 'pressed'], target: 24 },
};

for (const [composition, { states, target }] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target })).toEqual([]);
  });
}
