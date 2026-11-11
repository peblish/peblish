import { Avatar } from '@peblish/ui/components/avatar';
import { Badge, type BadgeLabels } from '@peblish/ui/components/badge';
import { Card } from '@peblish/ui/components/card';
import { FactList, type Fact } from '@peblish/ui/components/fact-list';
import { Handle } from '@peblish/ui/components/handle';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
import type { ProfileData } from '../-load.ts';

/**
 * The sticky card of profile-side.html, a Mux Card: avatar (or the initial), name, handle, badges,
 * bio and the facts. `children` are the actions in its footer. Shared by the profile and its edit page.
 */
export function ProfileCard({ data, children }: { data: ProfileData; children?: ReactNode }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const { person, badges } = data;
  const name = person.displayName || person.name;
  const deleted = data.state === 'deleted';
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  const roles: BadgeLabels = { admin: t('profiles', 'badge.admin'), moderator: t('profiles', 'badge.moderator'), op: '' };
  const facts: Fact[] = [
    { key: 'joined', label: t('profiles', 'card.joined'), value: date(data.joinedAt) },
    { key: 'posts', label: t('profiles', 'card.posts'), value: count(data.counts.posts) },
    { key: 'comments', label: t('profiles', 'card.comments'), value: count(data.counts.comments) },
    ...(data.home
      ? [
          {
            key: 'home',
            label: t('profiles', 'card.home'),
            value: data.home.age
              ? t('profiles', 'card.homeValue', { host: data.home.host, age: data.home.age })
              : t('profiles', 'card.homeNever', { host: data.home.host }),
          },
        ]
      : []),
  ];
  return (
    <aside className="prof-card" aria-label={t('profiles', 'card.label')}>
      <Card.Root variant="outlined">
        <Card.Header className="prof-head">
          {/* Without a picture the initial is decorative: the heading names the person. */}
          <Avatar.Root size="lg" aria-hidden={data.avatarSrc ? undefined : 'true'}>
            {data.avatarSrc && <Avatar.Image src={data.avatarSrc} alt={t('profiles', 'card.avatar', { name })} />}
            <Avatar.Fallback>{name.slice(0, 1).toUpperCase()}</Avatar.Fallback>
          </Avatar.Root>
          <Text as="h1" variant="title" size="lg" className="prof-name">
            {name}
          </Text>
          <Text as="p" variant="mono" size="sm" color="muted">
            <Handle prefix="@" handle={person.handle} />
          </Text>
          {!deleted && (badges.admin || badges.moderator || badges.bot || badges.you) && (
            <p className="prof-badges">
              {badges.admin && <Badge kind="admin" labels={roles} />}
              {badges.moderator && <Badge kind="moderator" labels={roles} />}
              {badges.bot && <Badge kind="bot">{t('profiles', 'badge.bot')}</Badge>}
              {badges.you && <Badge kind="you">{t('profiles', 'badge.you')}</Badge>}
            </p>
          )}
        </Card.Header>
        {(data.bioHtml || !deleted) && (
          <Card.Body className="prof-body">
            {data.bioHtml && <Prose html={data.bioHtml} className="prof-bio" />}
            {!deleted && <FactList items={facts} />}
          </Card.Body>
        )}
        {children && <Card.Footer className="prof-actions">{children}</Card.Footer>}
      </Card.Root>
    </aside>
  );
}
