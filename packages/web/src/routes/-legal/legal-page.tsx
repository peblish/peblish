import { Link } from '@peblish/ui/components/link';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import type { LegalPageData } from './load.ts';

/**
 * A public page (the mock's Feddit pages): its title as the H1 and its text, in the language the page is
 * written in (the reader's, else English, so `lang` is set on the article), then the list of every live
 * page under a rule. The frame's view header shows the title once the H1 has scrolled under it, so a long
 * title is never cut short.
 */
export function LegalPage({ data }: { data: LegalPageData }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const { page, about, links } = data;
  return (
    <main className="pb-page legal-page">
      {page ? (
        <article lang={page.language} className="legal-text">
          <Text as="h1" variant="heading" size="md">
            {page.title}
          </Text>
          <Prose html={page.html} />
        </article>
      ) : (
        about && (
          <article className="legal-text">
            <Text as="h1" variant="heading" size="md">
              {t('admin', 'legal.about.title', { name: about.name })}
            </Text>
            {about.description && <Text as="p">{about.description}</Text>}
          </article>
        )
      )}
      {links.length > 0 && (
        <nav className="legal-list" aria-labelledby="legal-list">
          <Text as="h2" variant="label" size="sm" color="muted" id="legal-list">
            {t('admin', 'legal.list')}
          </Text>
          <ul className="legal-links">
            {links.map((link) => (
              <li key={link.slug}>
                <Link href={`/${link.slug}`} current={link.slug === data.slug}>
                  {link.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </main>
  );
}
