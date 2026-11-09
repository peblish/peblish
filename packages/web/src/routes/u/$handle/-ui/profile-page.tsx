import { Button } from '@peblish/ui/components/button';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../../shell/hydration.ts';
import { userPath } from '../../../../shell/paths.ts';
import { BlockForm } from '../../../settings/blocks/-ui/block-form.tsx';
import type { ProfileActionProps } from '../../../-actions/props.ts';
import { ProfileBlock } from '../../-ui/actions/block.tsx';
import { ProfileModerate } from '../../-ui/actions/moderate.tsx';
import { ProfileReport } from '../../-ui/actions/report.tsx';
import type { ProfileData } from '../-load.ts';
import { Activity } from './activity.tsx';
import { ProfileCard } from './profile-card.tsx';

/** What sits under the card: nothing signed out, Edit profile and Settings on one's own page, else the three slots. */
function Actions({ data, path }: { data: ProfileData; path: string }) {
  const { t } = useTranslate();
  if (!data.viewer || data.state === 'deleted') return null;
  if (data.badges.you)
    return (
      <p className="prof-actions">
        <a className="prof-edit" href={`${path}/edit`}>
          {t('profiles', 'actions.edit')}
        </a>
        <a href="/settings/account">{t('profiles', 'actions.settings')}</a>
      </p>
    );
  const props: ProfileActionProps = {
    person: data.person,
    viewer: { actorId: data.viewer.actorId, moderator: data.moderatedCommunities.length > 0, admin: data.viewer.admin },
    moderatedCommunities: data.moderatedCommunities,
    back: path,
  };
  return (
    <div className="prof-actions">
      {data.blocked === null && <ProfileBlock {...props} />}
      <ProfileReport {...props} />
      <ProfileModerate {...props} />
    </div>
  );
}

/** The notice that replaces the activity of a person the viewer blocks, with the way back. */
function BlockedNotice({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  if (data.blocked === 'instance')
    return (
      <p className="prof-notice" role="status">
        {t('profiles', 'blocked.instance', { host: data.person.handle.split('@')[1] ?? '' })}{' '}
        <a href="/settings/blocks?tab=instances">{t('profiles', 'blocked.unblockInstance')}</a>
      </p>
    );
  return (
    <div className="prof-notice" role="status">
      <p>{t('profiles', 'blocked.actor')}</p>
      <BlockForm kind="person" fields={{ intent: 'remove', kind: 'person', target: data.person.id, back: userPath(data.person) }}>
        <Button type="submit" variant="neutral">
          {t('profiles', 'blocked.unblock')}
        </Button>
      </BlockForm>
    </div>
  );
}

/** profile-side.html: a sticky card beside the activity, which a deleted account or a block replaces with a notice. */
export function ProfilePage({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = userPath(data.person);
  return (
    <main className="pb-page prof">
      <div className="prof-lay">
        <ProfileCard data={data}>
          <Actions data={data} path={path} />
        </ProfileCard>
        <section className="prof-main" aria-label={t('profiles', 'tabs.label')}>
          {data.state === 'deleted' ? (
            <p className="prof-notice" role="status">
              {t('profiles', 'deleted')}
            </p>
          ) : data.blocked ? (
            <BlockedNotice data={data} />
          ) : (
            <Activity data={data} path={path} />
          )}
        </section>
      </div>
    </main>
  );
}
