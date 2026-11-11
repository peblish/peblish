import type { CurrentSession } from '@peblish/core/identity/session';
import type { SessionView } from '@peblish/schema/session';

/**
 * Who may use an admin page: the role says admin, and the session passed two-factor (as
 * /admin/registration decides). An admin denied with two-factor on signed this session in
 * without a code (one from before it was turned on), so signing in again fixes it.
 */
export type Access = 'ok' | 'not-admin' | 'needs-two-factor' | 'needs-two-factor-sign-in';

export const accessOf = (session: Pick<CurrentSession, 'role'> & { view: Pick<SessionView, 'siteRole' | 'twoFactorEnabled'> }): Access =>
  session.role !== 'admin'
    ? 'not-admin'
    : session.view.siteRole === 'admin'
      ? 'ok'
      : session.view.twoFactorEnabled
        ? 'needs-two-factor-sign-in'
        : 'needs-two-factor';
