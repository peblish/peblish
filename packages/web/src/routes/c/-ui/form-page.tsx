import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath } from '../../../shell/paths.ts';
import { errorKey } from '../-errors.ts';
import type { FormData } from '../-form-load.ts';
import { CommunityForm } from './community-form.tsx';

/** The form, or why this viewer does not get it (their reason, in place: the page answered 403). */
export function FormPage({ data, error, back }: { data: FormData; error: string | undefined; back?: string }) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (data.status === 'ok')
    return (
      // Keyed by the community, so the router reusing this component for another one starts its form afresh.
      <CommunityForm key={data.handle ?? 'new'} handle={data.handle} initial={data.initial} uploadsOff={data.uploadsOff} error={error} />
    );
  const reason = data.status === 'refused' ? data.reason : 'target.not_found';
  return (
    <main className="cm-form cm-refused" data-state="refused">
      <Text as="h1" variant="heading" size="md">
        {t('communities', 'form.refused')}
      </Text>
      <Notice
        tone="danger"
        role="alert"
        action={back !== undefined ? <Link href={communityPath({ handle: back })}>{t('communities', 'form.back')}</Link> : undefined}
      >
        {t('communities', errorKey(reason))}
      </Notice>
    </main>
  );
}
