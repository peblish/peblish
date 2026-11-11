import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
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

/** What sits in the card's footer for a signed-in viewer: Edit profile and Settings on one's own page, else the three slots. */
function Actions({ data, path }: { data: ProfileData & { viewer: NonNullable<ProfileData['viewer']> }; path: string }) {
  const { t } = useTranslate();
  if (data.badges.you)
    return (
      <>
        <Link href={`${path}/edit`}>{t('profiles', 'actions.edit')}</Link>
        <Link href="/settings/account">{t('profiles', 'actions.settings')}</Link>
      </>
    );
  const props: ProfileActionProps = {
    person: data.person,
    viewer: { actorId: data.viewer.actorId, moderator: data.moderatedCommunities.length > 0, admin: data.viewer.admin },
    moderatedCommunities: data.moderatedCommunities,
    back: path,
  };
  return (
    <>
      {data.blocked === null && <ProfileBlock {...props} />}
      <ProfileReport {...props} />
      <ProfileModerate {...props} />
    </>
  );
}

/** The notice that replaces the activity of a person the viewer blocks, with the way back. */
function BlockedNotice({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  if (data.blocked === 'instance')
    return (
      <Notice role="status" action={<Link href="/settings/blocks?tab=instances">{t('profiles', 'blocked.unblockInstance')}</Link>}>
        {t('profiles', 'blocked.instance', { host: data.person.handle.split('@')[1] ?? '' })}
      </Notice>
    );
  return (
    <Notice
      role="status"
      action={
        <BlockForm kind="person" fields={{ intent: 'remove', kind: 'person', target: data.person.id, back: userPath(data.person) }}>
          <Button type="submit" variant="neutral">
            {t('profiles', 'blocked.unblock')}
          </Button>
        </BlockForm>
      }
    >
      {t('profiles', 'blocked.actor')}
    </Notice>
  );
}

/** profile-side.html: a sticky card beside the activity, which a deleted account or a block replaces with a notice. */
export function ProfilePage({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = userPath(data.person);
  const viewer = data.state === 'deleted' ? null : data.viewer;
  return (
    <main className="pb-page prof">
      <div className="prof-lay">
        <ProfileCard data={data}>{viewer && <Actions data={{ ...data, viewer }} path={path} />}</ProfileCard>
        <section className="prof-main" aria-label={t('profiles', 'tabs.label')}>
          {data.state === 'deleted' ? (
            <Notice role="status">{t('profiles', 'deleted')}</Notice>
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
