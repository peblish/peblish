import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { useTranslate } from '../../i18n/use-translate.ts';
import type { Access } from './settings/-access.ts';

/**
 * Why an admin page refuses this visitor (`accessOf`), in the area's own words for "not an
 * admin" and "turn on two-factor", as an alert Notice. An account that has two-factor on but
 * whose session skipped it gets the one shared sentence: signing in again with a code fixes it.
 * The loader answers the page with 403.
 */
export function Denial({
  access,
  copy,
}: {
  access: Exclude<Access, 'ok'>;
  copy: { needsTwoFactor: string; securityLink: string; notAdmin: string };
}) {
  const { t } = useTranslate();
  if (access === 'needs-two-factor-sign-in')
    return (
      <Notice role="alert" tone="warning">
        {t('admin', 'access.signInWithTwoFactor')}
      </Notice>
    );
  if (access === 'needs-two-factor')
    return (
      <Notice role="alert" tone="warning">
        {copy.needsTwoFactor} <Link href="/settings/security">{copy.securityLink}</Link>
      </Notice>
    );
  return (
    <Notice role="alert" tone="warning">
      {copy.notAdmin}
    </Notice>
  );
}
