import type { ActorRef } from '@peblish/schema/views';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { modlogPath } from '../../../shell/paths.ts';
import type { CommunityActionProps, ContentActionProps, ProfileActionProps } from '../../-actions/props.ts';
import { BanFields, ModStyles, Panel, ReasonFields } from './panels.tsx';

// What the four `moderate` slots draw (decisions, "Shared slots"). Each decides for itself
// whether it shows anything: only a moderator of the community or an admin sees a panel.

/** Remove (or restore) a post or comment, and ban its author from the community. */
export function ContentModerate({ kind, ...props }: ContentActionProps & { kind: 'post' | 'comment' }) {
  const { t } = useTranslate();
  const { target, author, community, removed, deleted, viewer, back } = props;
  if (!viewer.moderator && !viewer.admin) return null;
  const self = author.id === viewer.actorId;
  const place = t('modlog', 'panel.target', { author: `@${author.handle}`, community: `!${community.handle}` });
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
            <p className="mod-hint">{place}</p>
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
            <p className="mod-hint">{place}</p>
            <ReasonFields required id={`remove-${target.id}`} />
          </Panel>
        ))}
      {!self && author.kind === 'Person' && (
        <Panel
          panel={`ban:${author.id}`}
          summary={t('modlog', 'panel.ban.community', { community: `!${community.handle}` })}
          intent="ban"
          fields={{ community: community.id, person: author.id }}
          back={back}
          submit={t('modlog', 'panel.submit.ban')}
        >
          <p className="mod-hint">{t('modlog', 'panel.ban.who', { author: `@${author.handle}`, community: `!${community.handle}` })}</p>
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
  return (
    <div className="mod-slot" data-testid="profile-moderate">
      {community && (
        <Panel
          panel={`ban:${person.id}`}
          summary={t('modlog', 'panel.ban.community', {
            community: communities.length === 1 ? `!${community.handle}` : t('modlog', 'panel.ban.aCommunity'),
          })}
          intent="ban"
          fields={{ community: community.id, person: person.id }}
          back={back}
          submit={t('modlog', 'panel.submit.ban')}
        >
          {communities.length > 1 && (
            <div className="mod-fld">
              <label htmlFor={`ban-community-${person.id}`}>{t('modlog', 'panel.community')}</label>
              <select
                id={`ban-community-${person.id}`}
                value={community.id}
                onChange={(event) => setCommunityId(event.currentTarget.value)}
              >
                {communities.map((one) => (
                  <option key={one.id} value={one.id}>
                    !{one.handle}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mod-hint">{t('modlog', 'panel.ban.who', { author: `@${person.handle}`, community: `!${community.handle}` })}</p>
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
          <p className="mod-hint">{t('modlog', 'panel.ban.siteWho', { person: `@${person.handle}` })}</p>
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
      <a href={modlogPath(community.handle)}>{t('modlog', 'panel.modlog')}</a>
    </div>
  );
}
