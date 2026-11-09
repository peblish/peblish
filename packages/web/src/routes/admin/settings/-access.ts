import type { CurrentSession } from '@peblish/core/identity/session';

/** Who may use an admin page: the role says admin, and the session says two-factor is on (as /admin/registration decides). */
export type Access = 'ok' | 'not-admin' | 'needs-two-factor';

export const accessOf = (session: CurrentSession): Access =>
  session.role !== 'admin' ? 'not-admin' : session.view.siteRole !== 'admin' ? 'needs-two-factor' : 'ok';
