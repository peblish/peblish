import { Avatar } from '@peblish/ui/components/avatar';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { Badge, type BadgeLabels } from '@peblish/ui/components/badge';
import { FactList, type Fact } from '@peblish/ui/components/fact-list';
import { BidiText, Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
import type { ProfileData } from '../-load.ts';

/** A remote person's home and how fresh this copy is, as one line ("lantern.cafe, copy refreshed 3h"); null for a local one. */
export function useHomeLine(data: ProfileData): string | null {
  const { t } = useTranslate();
  if (!data.home) return null;
  return data.home.age
    ? t('profiles', 'card.homeValue', { host: data.home.host, age: data.home.age })
    : t('profiles', 'card.homeNever', { host: data.home.host });
}

/**
 * The person at the top of their page (Commons, the mock's person header): avatar (or the initial), name
 * and badges, handle, bio, then the facts in a line (joined, posts, comments) and, for a remote person, their
 * home, which the rail holds where it is shown (profile.css). `children` are the actions under it. A region
 * named Profile; shared by the profile and its edit page.
 */
export function ProfileHero({ data, children }: { data: ProfileData; children?: ReactNode }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const home = useHomeLine(data);
  const { person, badges } = data;
  const name = person.displayName || person.name;
  // A remote name may carry directional controls: the heading isolates it (BidiText), the initial and alt text drop them.
  const plainName = neutraliseBidi(name, '');
  const deleted = data.state === 'deleted';
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  const roles: BadgeLabels = { admin: t('profiles', 'badge.admin'), moderator: t('profiles', 'badge.moderator'), op: '' };
  const facts: Fact[] = [
    { key: 'joined', label: t('profiles', 'card.joined'), value: date(data.joinedAt) },
    { key: 'posts', label: t('profiles', 'card.posts'), value: count(data.counts.posts) },
    { key: 'comments', label: t('profiles', 'card.comments'), value: count(data.counts.comments) },
  ];
  return (
    <section className="prof-hero" aria-label={t('profiles', 'card.label')}>
      <div className="prof-hero__head">
        {/* Without a picture the initial is decorative: the heading names the person. */}
        <Avatar.Root size="lg" aria-hidden={data.avatarSrc ? undefined : 'true'}>
          {data.avatarSrc && <Avatar.Image src={data.avatarSrc} alt={t('profiles', 'card.avatar', { name: plainName })} />}
          <Avatar.Fallback>{avatarInitial(plainName, '')}</Avatar.Fallback>
        </Avatar.Root>
        <div className="prof-hero__id">
          <div className="prof-hero__title">
            <Text as="h1" variant="title" size="sm" className="prof-name">
              <BidiText text={name} />
            </Text>
            {!deleted && (badges.admin || badges.moderator || badges.bot || badges.you) && (
              <span className="prof-badges">
                {badges.admin && <Badge kind="admin" labels={roles} />}
                {badges.moderator && <Badge kind="moderator" labels={roles} />}
                {badges.bot && <Badge kind="bot">{t('profiles', 'badge.bot')}</Badge>}
                {badges.you && <Badge kind="you">{t('profiles', 'badge.you')}</Badge>}
              </span>
            )}
          </div>
          <Text as="p" variant="mono" size="sm" color="muted" className="prof-handle">
            <Handle prefix="@" handle={person.handle} />
          </Text>
        </div>
      </div>
      {data.bioHtml && <Prose html={data.bioHtml} className="prof-bio" />}
      {!deleted && <FactList layout="inline" items={facts} className="prof-facts" />}
      {!deleted && home && (
        <FactList layout="inline" className="prof-hero__home" items={[{ key: 'home', label: t('profiles', 'card.home'), value: home }]} />
      )}
      {children && <div className="prof-actions">{children}</div>}
    </section>
  );
}
