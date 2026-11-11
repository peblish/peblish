import { Link } from '@tanstack/react-router';
import { useTranslate } from '../../i18n/use-translate.ts';
import type { Access } from './settings/-access.ts';

/**
 * Why an admin page refuses this visitor (`accessOf`), in the area's own words for "not an
 * admin" and "turn on two-factor". An account that has two-factor on but whose session skipped
 * it gets the one shared sentence: signing in again with a code fixes it.
 */
export function Denial({
  access,
  copy,
}: {
  access: Exclude<Access, 'ok'>;
  copy: { needsTwoFactor: string; securityLink: string; notAdmin: string };
}) {
  const { t } = useTranslate();
  if (access === 'needs-two-factor-sign-in') return <p role="alert">{t('admin', 'access.signInWithTwoFactor')}</p>;
  if (access === 'needs-two-factor')
    return (
      <p role="alert">
        {copy.needsTwoFactor} <Link to="/settings/security">{copy.securityLink}</Link>
      </p>
    );
  return <p role="alert">{copy.notAdmin}</p>;
}
