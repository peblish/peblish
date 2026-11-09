import { Badge } from '@peblish/ui/components/badge';
import { Handle } from '@peblish/ui/components/handle';
import { Prose } from '@peblish/ui/components/prose';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
import type { ProfileData } from '../-load.ts';

/**
 * The sticky card of profile-side.html: avatar (or the initial), name, handle, badges, bio and
 * the facts. `children` are the actions under it. Shared by the profile and its edit page.
 */
export function ProfileCard({ data, children }: { data: ProfileData; children?: ReactNode }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const { person, badges } = data;
  const name = person.displayName || person.name;
  const deleted = data.state === 'deleted';
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  return (
    <aside className="prof-card" aria-label={t('profiles', 'card.label')}>
      {data.avatarSrc ? (
        <img className="prof-avatar" src={data.avatarSrc} alt={t('profiles', 'card.avatar', { name })} width={64} height={64} />
      ) : (
        <span className="prof-avatar prof-initial" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <h1>{name}</h1>
      <p className="prof-handle pb-mono">
        <Handle prefix="@" handle={person.handle} />
      </p>
      {!deleted && (badges.admin || badges.moderator || badges.bot || badges.you) && (
        <p className="prof-badges">
          {badges.admin && (
            <Badge kind="admin" labels={{ admin: t('profiles', 'badge.admin'), moderator: t('profiles', 'badge.moderator'), op: '' }} />
          )}
          {badges.moderator && (
            <Badge kind="moderator" labels={{ admin: t('profiles', 'badge.admin'), moderator: t('profiles', 'badge.moderator'), op: '' }} />
          )}
          {badges.bot && <span className="pb-badge prof-badge">{t('profiles', 'badge.bot')}</span>}
          {badges.you && <span className="pb-badge prof-badge">{t('profiles', 'badge.you')}</span>}
        </p>
      )}
      {data.bioHtml && <Prose html={data.bioHtml} className="prof-bio" />}
      {!deleted && (
        <dl className="prof-facts">
          <div>
            <dt>{t('profiles', 'card.joined')}</dt>
            <dd>{date(data.joinedAt)}</dd>
          </div>
          <div>
            <dt>{t('profiles', 'card.posts')}</dt>
            <dd>{count(data.counts.posts)}</dd>
          </div>
          <div>
            <dt>{t('profiles', 'card.comments')}</dt>
            <dd>{count(data.counts.comments)}</dd>
          </div>
          {data.home && (
            <div>
              <dt>{t('profiles', 'card.home')}</dt>
              <dd>
                {data.home.age
                  ? t('profiles', 'card.homeValue', { host: data.home.host, age: data.home.age })
                  : t('profiles', 'card.homeNever', { host: data.home.host })}
              </dd>
            </div>
          )}
        </dl>
      )}
      {children}
    </aside>
  );
}
