import { listPeers, type PeerRow } from '@peblish/core/peers/read';
import { readSetting } from '@peblish/core/settings/read';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { pageSession } from '../../../server/auth.ts';
import { adminPaths } from '../../../shell/paths.ts';

export type PeersData = { access: 'not-admin' | 'needs-two-factor' } | { access: 'ok'; peers: PeerRow[]; trusted: string[] };

export const loadPeers = createServerFn({ method: 'GET' }).handler(async (): Promise<PeersData> => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: adminPaths.peers } });
  // Signed in but not an admin with two-factor on: the denial copy, answered as a 403 (as the report queue does).
  if (session.role !== 'admin' || session.view.siteRole !== 'admin') {
    setResponseStatus(403);
    return { access: session.role !== 'admin' ? 'not-admin' : 'needs-two-factor' };
  }
  const [peers, trusted] = await Promise.all([listPeers(), readSetting('modlog.trusted_instances')]);
  return { access: 'ok', peers, trusted };
});
