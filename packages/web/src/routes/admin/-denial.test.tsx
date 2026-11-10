import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { translate } from '../../i18n/translate.ts';

// No router or root loader here: the locale comes from the mock, the link renders as a plain anchor.
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
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: string }) => <a href={to}>{children}</a>,
}));

const { Denial } = await import('./-denial.tsx');

const copy = { needsTwoFactor: 'Turn it on.', securityLink: 'Security', notAdmin: 'Admins only.' };

test.each(['en', 'de'])(
  'an admin page tells an account with two-factor on, whose session skipped it, to sign in again with a code (%s)',
  (language) => {
    locale.current = language;
    const html = renderToStaticMarkup(<Denial access="needs-two-factor-sign-in" copy={copy} />);
    expect(html).toBe(`<p role="alert">${translate(language, 'admin', 'access.signInWithTwoFactor')}</p>`);
    expect(html).not.toContain(copy.needsTwoFactor);
    // The other two answers keep the area's own words, and only "turn it on" links to the security page.
    expect(renderToStaticMarkup(<Denial access="needs-two-factor" copy={copy} />)).toBe(
      '<p role="alert">Turn it on. <a href="/settings/security">Security</a></p>',
    );
    expect(renderToStaticMarkup(<Denial access="not-admin" copy={copy} />)).toBe('<p role="alert">Admins only.</p>');
  },
);

test('the sentence exists in German, not as an English fallback', () => {
  expect(translate('de', 'admin', 'access.signInWithTwoFactor')).toBe(
    'Melde dich erneut mit einem Zwei-Faktor-Code an, um diese Seite zu nutzen.',
  );
});
