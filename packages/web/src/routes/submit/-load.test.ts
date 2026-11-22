import { describe, expect, test, vi } from 'vitest';

// The composer's panel loader itself (its handler, with createServerFn handing it back as it is):
// a community the person could not see (core's composerCommunity, tested in communities/start.test.ts)
// sends no panel.

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({ validator: () => ({ handler: <F>(fn: F) => fn }) }),
}));
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => new Request('https://feddit.test/submit') }));
vi.mock('../../server/auth.ts', () => ({
  pageSession: async () => ({ view: { actorId: 'me', siteRole: 'user', ageDeclaredAt: '2026-01-01T00:00:00.000Z' } }),
  sameOrigin: () => true,
}));
vi.mock('../../server/markdown.ts', () => ({
  createMarkdownRenderer: async () => ({
    render: () => ({ html: '<p>Be kind</p>', excerpt: 'Our rules' }),
    sanitize: () => ({ html: '', excerpt: '' }),
  }),
}));
const state = vi.hoisted(() => ({ blocked: false }));
vi.mock('@peblish/core/communities/read', () => ({ moderatedAmong: async () => new Set(), readCommunity: async () => null }));
vi.mock('@peblish/core/communities/start', () => ({
  composerCommunity: async () =>
    state.blocked
      ? null
      : {
          actor: {
            id: '019a0000-0000-7000-8000-0000000c0111',
            apId: 'https://lemmy.test/c/lab',
            kind: 'Group',
            name: 'lab',
            displayName: null,
            local: false,
            handle: 'lab@lemmy.test',
          },
          summaryMd: 'Our rules',
          summaryHtml: null,
          postingWarning: null,
          postingRestrictedToMods: false,
          rules: [{ title: 'Be kind', bodyMd: 'Be kind' }],
          sensitive: false,
          nsfl: false,
        },
}));
vi.mock('@peblish/core/identity/handles', () => ({ localHandles: async () => ({ handle: (name: string) => ({ handle: name }) }) }));
vi.mock('@peblish/core/posts/read', () => ({ readPost: async () => null }));
vi.mock('@peblish/core/settings/read', () => ({ readSetting: async () => true }));
vi.mock('./-picker.ts', () => ({
  composerViewer: () => ({ actorId: 'me', declared: true }),
  pickerFor: async () => ({ communities: [], truncated: false, selected: null }),
}));
const { loadCommunityPanel } = await import('./-load.ts');

describe("a community's panel", () => {
  const panel = async (blocked: boolean) => {
    state.blocked = blocked;
    return (await loadCommunityPanel({ data: { id: '019a0000-0000-7000-8000-0000000c0111' } })).panel;
  };

  test('is not sent for a community the person could not see', async () => {
    expect(await panel(true)).toBeNull();
  });

  test('is sent, with its rules, otherwise', async () => {
    expect(await panel(false)).toMatchObject({ handle: 'lab@lemmy.test', rules: [{ title: 'Be kind' }] });
  });
});
