import type { ActorRef } from '@peblish/schema/views';
import { BidiText, neutraliseBidi } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Select } from '@peblish/ui/components/select';
import { Text } from '@peblish/ui/components/text';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { modlogPath } from '../../../shell/paths.ts';
import type { CommunityActionProps, ContentActionProps, ProfileActionProps } from '../../-actions/props.ts';
import { BanFields, ModStyles, Panel, ReasonFields } from './panels.tsx';
import { placeholders, withNames } from './rich.tsx';

// What the four `moderate` slots draw (decisions, "Shared slots"). Each decides for itself
// whether it shows anything: only a moderator of the community or an admin sees a panel.

/** Remove (or restore) a post or comment, and ban its author from the community. */
export function ContentModerate({ kind, ...props }: ContentActionProps & { kind: 'post' | 'comment' }) {
  const { t } = useTranslate();
  const { target, author, community, removed, deleted, viewer, back } = props;
  if (!viewer.moderator && !viewer.admin) return null;
  const self = author.id === viewer.actorId;
  // Handles from other servers, isolated in the sentences that name them.
  const names = { author: `@${author.handle}`, community: `!${community.handle}` };
  const say = (key: 'panel.target' | 'panel.ban.who') => withNames(t('modlog', key, placeholders(names)), names);
  const place = say('panel.target');
  return (
    <div className="mod-slot" data-testid={`${kind}-moderate`}>
      {!deleted &&
        (removed ? (
          <Panel
            panel={`content:${target.id}`}
            summary={t('modlog', `panel.restore.${kind}`)}
            intent="restore"
            fields={{ kind, id: target.id }}
            back={back}
            submit={t('modlog', 'panel.submit.restore')}
          >
            <Text as="p" size="sm" color="muted" className="mod-note">
              {place}
            </Text>
            <ReasonFields required={false} id={`restore-${target.id}`} />
          </Panel>
        ) : (
          <Panel
            panel={`content:${target.id}`}
            summary={t('modlog', `panel.remove.${kind}`)}
            intent="remove"
            fields={{ kind, id: target.id }}
            back={back}
            submit={t('modlog', 'panel.submit.remove')}
          >
            <Text as="p" size="sm" color="muted" className="mod-note">
              {place}
            </Text>
            <ReasonFields required id={`remove-${target.id}`} />
          </Panel>
        ))}
      {!self && author.kind === 'Person' && (
        <Panel
          panel={`ban:${author.id}`}
          // The author may have a post and comments on one page, each with this panel.
          id={`mod-ban-${target.id}`}
          // One run: the trigger lays out its children as flex items, so a BidiText inside the sentence would sit apart.
          summary={<BidiText text={t('modlog', 'panel.ban.community', names)} />}
          intent="ban"
          fields={{ community: community.id, person: author.id }}
          back={back}
          submit={t('modlog', 'panel.submit.ban')}
        >
          <Text as="p" size="sm" color="muted" className="mod-note">
            {say('panel.ban.who')}
          </Text>
          <BanFields id={`ban-${target.id}`} person={author.id} community={community.id} />
          <ReasonFields required id={`ban-${target.id}`} />
        </Panel>
      )}
    </div>
  );
}

/**
 * A profile: ban the person from a community the viewer moderates (they pick one when there are
 * several), and, for an admin, from the whole instance.
 */
export function ProfileModerateTools({ person, viewer, moderatedCommunities, back }: ProfileActionProps) {
  const { t } = useTranslate();
  const [communityId, setCommunityId] = useState(moderatedCommunities[0]?.id);
  if (person.id === viewer.actorId || person.kind !== 'Person') return null;
  const communities = moderatedCommunities;
  if (communities.length === 0 && !viewer.admin) return null;
  const community: ActorRef | undefined = communities.find((one) => one.id === communityId) ?? communities[0];
  const names = { person: `@${person.handle}`, author: `@${person.handle}`, community: community ? `!${community.handle}` : '' };
  const say = (key: 'panel.ban.who' | 'panel.ban.siteWho') => withNames(t('modlog', key, placeholders(names)), names);
  return (
    <div className="mod-slot" data-testid="profile-moderate">
      {community && (
        <Panel
          panel={`ban:${person.id}`}
          summary={
            communities.length === 1 ? <BidiText text={t('modlog', 'panel.ban.community', names)} /> : t('modlog', 'panel.ban.aCommunity')
          }
          intent="ban"
          // With a choice, the select itself is the `community` field, so a form sent before hydration posts the chosen one.
          fields={communities.length > 1 ? { person: person.id } : { community: community.id, person: person.id }}
          back={back}
          submit={t('modlog', 'panel.submit.ban')}
        >
          {communities.length > 1 && (
            <Select
              label={t('modlog', 'panel.community')}
              name="community"
              value={community.id}
              onChange={setCommunityId}
              items={communities.map((one) => ({ id: one.id, label: neutraliseBidi(`!${one.handle}`, '') }))}
            />
          )}
          <Text as="p" size="sm" color="muted" className="mod-note">
            {say('panel.ban.who')}
          </Text>
          <BanFields id={`ban-${person.id}`} person={person.id} community={community.id} />
          <ReasonFields required id={`ban-${person.id}`} />
        </Panel>
      )}
      {viewer.admin && (
        <Panel
          panel={`site_ban:${person.id}`}
          summary={t('modlog', 'panel.ban.site')}
          intent="site_ban"
          fields={{ person: person.id }}
          back={back}
          submit={t('modlog', 'panel.submit.ban')}
        >
          <Text as="p" size="sm" color="muted" className="mod-note">
            {say('panel.ban.siteWho')}
          </Text>
          <BanFields id={`site-${person.id}`} person={person.id} />
          <ReasonFields required id={`site-${person.id}`} />
        </Panel>
      )}
    </div>
  );
}

/** The community page's Mod tools: the way into this community's modlog. */
export function CommunityModerateTools({ community, viewer }: CommunityActionProps) {
  const { t } = useTranslate();
  if (!viewer.moderator && !viewer.admin) return null;
  return (
    <div className="mod-slot" data-testid="community-moderate">
      <ModStyles />
      <Link href={modlogPath(community.handle)}>{t('modlog', 'panel.modlog')}</Link>
    </div>
  );
}
