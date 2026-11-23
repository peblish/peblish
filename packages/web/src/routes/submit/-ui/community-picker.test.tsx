import { renderToString } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { PickerCommunity } from '../-types.ts';

// The radio list a browser without scripts gets, as the server renders it.
vi.mock('../../../i18n/use-translate.ts', () => ({ useTranslate: () => ({ locale: 'en', t: (_area: string, key: string) => key }) }));

const { CommunityRadios } = await import('./community-picker.tsx');

const communities: PickerCommunity[] = [{ id: 'c1', handle: 'tea', local: true, subscribers: 3, canPost: true, restricted: false }];
const radios = (truncated: boolean) =>
  renderToString(<CommunityRadios communities={communities} truncated={truncated} value={null} describe={() => 'local'} />);

test('a list the loader cut short says so, with the directory’s link', () => {
  const html = radios(true);
  expect(html).toContain('community.truncated');
  expect(html).toMatch(/<a [^>]*href="\/communities"[^>]*>community\.browse<\/a>/);
  expect(radios(false)).not.toContain('community.truncated');
});
