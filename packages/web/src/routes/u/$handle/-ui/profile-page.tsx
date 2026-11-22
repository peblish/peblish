import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { FactList } from '@peblish/ui/components/fact-list';
import { handleHost, neutraliseBidi } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { getRouteApi } from '@tanstack/react-router';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../../shell/hydration.ts';
import { userPath } from '../../../../shell/paths.ts';
import { Rail } from '../../../../shell/rail.tsx';
import { BlockForm } from '../../../settings/blocks/-ui/block-form.tsx';
import type { ProfileActionProps } from '../../../-actions/props.ts';
import { ProfileBlock } from '../../-ui/actions/block.tsx';
import { ProfileModerate } from '../../-ui/actions/moderate.tsx';
import { ProfileReport } from '../../-ui/actions/report.tsx';
import type { ProfileData } from '../-load.ts';
import { softwareName } from '../../../instances/-software.ts';
import { ModeratesPanel } from './moderates-panel.tsx';
import { Activity } from './activity.tsx';
import { ProfileHero } from './profile-hero.tsx';

const root = getRouteApi('__root__');

/** The actions under the person for a signed-in viewer: Edit profile and Settings on one's own page, else the three slots. */
function Actions({ data, path }: { data: ProfileData & { viewer: NonNullable<ProfileData['viewer']> }; path: string }) {
  const { t } = useTranslate();
  if (data.badges.you)
    return (
      <>
        {/* Neutral buttons, as Block and Report on another person's page. */}
        <ButtonLink href={`${path}/edit`} variant="neutral">
          {t('profiles', 'actions.edit')}
        </ButtonLink>
        <ButtonLink href="/settings/account" variant="neutral">
          {t('profiles', 'actions.settings')}
        </ButtonLink>
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
        {t('profiles', 'blocked.instance', { host: neutraliseBidi(handleHost(data.person.handle)) })}
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

/**
 * The rail beside a profile (Commons, the mock's person panels): the person's home instance, this site for
 * a local person, and for a remote one how fresh this copy is and its software ("Unknown" when this
 * server has not learnt it); then the communities they moderate. A deleted account has none.
 */
function ProfileRail({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  const { shell } = root.useLoaderData();
  return (
    <Rail label={t('profiles', 'rail.label')}>
      <RailPanel title={t('profiles', 'rail.home')}>
        <FactList
          size="xs"
          items={[
            { key: 'server', label: t('profiles', 'rail.server'), value: data.home?.host ?? shell.siteName },
            ...(data.home
              ? [{ key: 'refreshed', label: t('profiles', 'rail.refreshed'), value: data.home.age ?? t('profiles', 'rail.never') }]
              : []),
            ...(data.home
              ? [{ key: 'software', label: t('facts', 'home.software'), value: softwareName(data.homeSoftware) ?? t('facts', 'unknown') }]
              : []),
          ]}
        />
      </RailPanel>
      <ModeratesPanel moderates={data.moderates} more={data.moderatesMore} />
    </Rail>
  );
}

/**
 * A profile (Commons): the person over their activity in the centre, and their home in the rail. A deleted
 * account or a block replaces the activity with a notice.
 */
export function ProfilePage({ data }: { data: ProfileData }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = userPath(data.person);
  const viewer = data.state === 'deleted' ? null : data.viewer;
  return (
    <>
      <main className="pb-page prof">
        <ProfileHero data={data}>{viewer && <Actions data={{ ...data, viewer }} path={path} />}</ProfileHero>
        <section className="prof-main" aria-label={t('profiles', 'tabs.label')}>
          {data.state === 'deleted' ? (
            <Notice role="status">{t('profiles', 'deleted')}</Notice>
          ) : data.blocked ? (
            <BlockedNotice data={data} />
          ) : (
            <Activity data={data} path={path} />
          )}
        </section>
      </main>
      {data.state !== 'deleted' && <ProfileRail data={data} />}
    </>
  );
}
