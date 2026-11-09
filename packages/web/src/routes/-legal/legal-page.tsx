import { Prose } from '@peblish/ui/components/prose';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import type { LegalPageData } from './load.ts';

/**
 * A public page: its title as the H1 and its text, in the language the page is written in (the
 * reader's, else English, so `lang` is set on the article), then the list of every live page.
 */
export function LegalPage({ data }: { data: LegalPageData }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const { page, about, links } = data;
  return (
    <main className="legal-page">
      {page ? (
        <article lang={page.language}>
          <h1>{page.title}</h1>
          <Prose html={page.html} />
        </article>
      ) : (
        about && (
          <article>
            <h1>{t('admin', 'legal.about.title', { name: about.name })}</h1>
            {about.description && <p>{about.description}</p>}
          </article>
        )
      )}
      {links.length > 0 && (
        <nav className="legal-list" aria-labelledby="legal-list">
          <h2 id="legal-list">{t('admin', 'legal.list')}</h2>
          <ul>
            {links.map((link) => (
              <li key={link.slug}>
                <a href={`/${link.slug}`} aria-current={link.slug === data.slug ? 'page' : undefined}>
                  {link.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </main>
  );
}
