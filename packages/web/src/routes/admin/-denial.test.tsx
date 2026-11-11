import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { translate } from '../../i18n/translate.ts';

// No router or root loader here: the locale comes from the mock, the Mux link renders as a plain anchor.
const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('../../i18n/use-translate.ts', async () => {
  const { translate } = await import('../../i18n/translate.ts');
  return {
    useTranslate: () => ({
      locale: locale.current,
      t: (area: Parameters<typeof translate>[1], key: never) => translate(locale.current, area, key),
    }),
  };
});

const { Denial } = await import('./-denial.tsx');

const copy = { needsTwoFactor: 'Turn it on.', securityLink: 'Security', notAdmin: 'Admins only.' };

/** How many alerts the server markup holds, its text and its links (no DOM in these tests). */
function read(html: string) {
  return {
    alerts: html.match(/role="alert"/g)?.length ?? 0,
    text: html.replace(/<[^>]+>/g, ''),
    links: [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(([, href, text]) => [text, href]),
  };
}

test.each(['en', 'de'])(
  'an admin page tells an account with two-factor on, whose session skipped it, to sign in again with a code (%s)',
  (language) => {
    locale.current = language;
    expect(read(renderToStaticMarkup(<Denial access="needs-two-factor-sign-in" copy={copy} />))).toEqual({
      alerts: 1,
      text: translate(language, 'admin', 'access.signInWithTwoFactor'),
      links: [],
    });
    // The other two answers keep the area's own words, and only "turn it on" links to the security page.
    expect(read(renderToStaticMarkup(<Denial access="needs-two-factor" copy={copy} />))).toEqual({
      alerts: 1,
      text: 'Turn it on. Security',
      links: [['Security', '/settings/security']],
    });
    expect(read(renderToStaticMarkup(<Denial access="not-admin" copy={copy} />))).toEqual({ alerts: 1, text: 'Admins only.', links: [] });
  },
);

test('the sentence exists in German, not as an English fallback', () => {
  expect(translate('de', 'admin', 'access.signInWithTwoFactor')).toBe(
    'Melde dich erneut mit einem Zwei-Faktor-Code an, um diese Seite zu nutzen.',
  );
});
