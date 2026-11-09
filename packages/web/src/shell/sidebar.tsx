import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';
import { Handle } from '@peblish/ui/components/handle';
import { CloseIcon } from '@peblish/ui/components/icons';
import { useState, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import type { ShellData } from './data.ts';
import { communityPath, directoryPaths, feedPaths, sitePaths } from './paths.ts';

function NavLink({ href, pathname, children }: { href: string; pathname: string; children: ReactNode }) {
  return (
    <a href={href} aria-current={pathname === href ? 'page' : undefined}>
      {children}
    </a>
  );
}

function CommunityGroup({ title, communities, pathname }: { title: string; communities: readonly ActorRef[]; pathname: string }) {
  if (communities.length === 0) return null;
  return (
    <details open className="pb-side__group">
      <summary>{title}</summary>
      <ul>
        {communities.map((community) => (
          <li key={community.id}>
            <NavLink href={communityPath(community)} pathname={pathname}>
              <Handle prefix="!" handle={community.handle} />
            </NavLink>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The persistent left column (shell-sidebar): the feeds, the viewer's communities with a
 * filter, links to the directory and the resolver, and the site's pages. On a phone it is a
 * drawer the shell opens (see Shell for how it works before hydration); `onClose` is its
 * close link.
 */
export function Sidebar({
  session,
  shell,
  pathname,
  open,
  onClose,
}: {
  session: SessionView | null;
  shell: ShellData;
  pathname: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslate();
  const [filter, setFilter] = useState('');
  const matching = (communities: readonly ActorRef[]) => {
    const query = filter.trim().toLowerCase();
    return query === '' ? communities : communities.filter(({ handle }) => handle.toLowerCase().includes(query));
  };
  const local = matching(shell.local);
  const remote = matching(shell.remote);
  const hasCommunities = shell.local.length + shell.remote.length > 0;

  return (
    <aside className="pb-side" id="pb-side" aria-label={t('shell', 'sidebar.label')} data-open={open || undefined}>
      <a
        className="pb-side__close"
        href="#pb-main"
        aria-label={t('shell', 'menu.close')}
        onClick={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <CloseIcon />
      </a>
      <a className="pb-brand" href="/">
        <b>{t('shell', 'title')}</b>
      </a>
      <nav aria-label={t('shell', 'nav.feeds')}>
        <p className="pb-side__title">{t('shell', 'nav.feeds')}</p>
        <ul className="pb-side__links">
          {session && (
            <li>
              <NavLink href={feedPaths.subscribed} pathname={pathname}>
                {t('shell', 'feed.subscribed')}
              </NavLink>
            </li>
          )}
          <li>
            <NavLink href={feedPaths.local} pathname={pathname}>
              {t('shell', 'feed.local')}
            </NavLink>
          </li>
          <li>
            <NavLink href={feedPaths.all} pathname={pathname}>
              {t('shell', 'feed.all')}
            </NavLink>
          </li>
          <li>
            <NavLink href={feedPaths.popular} pathname={pathname}>
              {t('shell', 'feed.popular')}
            </NavLink>
          </li>
          {session && shell.moderating > 0 && (
            <li>
              <NavLink href={feedPaths.moderating} pathname={pathname}>
                {t('shell', 'feed.moderating')}
              </NavLink>
            </li>
          )}
        </ul>
      </nav>
      <nav aria-label={t('shell', 'nav.communities')}>
        <p className="pb-side__title">{t('shell', 'nav.communities')}</p>
        {hasCommunities && (
          <input
            type="search"
            className="pb-side__filter"
            aria-label={t('shell', 'communities.filter')}
            placeholder={t('shell', 'communities.filter')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <CommunityGroup title={t('shell', 'communities.local', { count: local.length })} communities={local} pathname={pathname} />
        <CommunityGroup title={t('shell', 'communities.remote', { count: remote.length })} communities={remote} pathname={pathname} />
        <ul className="pb-side__links">
          <li>
            <NavLink href={directoryPaths.browse} pathname={pathname}>
              {t('shell', 'communities.browse')}
            </NavLink>
          </li>
          <li>
            <NavLink href={directoryPaths.find} pathname={pathname}>
              {t('shell', 'communities.find')}
            </NavLink>
          </li>
        </ul>
      </nav>
      <nav className="pb-side__foot" aria-label={t('shell', 'footer.label')}>
        <a href={sitePaths.rules}>{t('shell', 'footer.rules')}</a>
        <a href={sitePaths.terms}>{t('shell', 'footer.terms')}</a>
        <a href={sitePaths.privacy}>{t('shell', 'footer.privacy')}</a>
        <a href={sitePaths.about}>{t('shell', 'footer.about')}</a>
      </nav>
    </aside>
  );
}
