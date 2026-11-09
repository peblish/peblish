import { listPeers, type PeerRow } from '@peblish/core/peers/read';
import { readSetting } from '@peblish/core/settings/read';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { pageSession } from '../../../server/auth.ts';
import { adminPaths } from '../../../shell/paths.ts';

export type PeersData = { access: 'not-admin' | 'needs-two-factor' } | { access: 'ok'; peers: PeerRow[]; trusted: string[] };

export const loadPeers = createServerFn({ method: 'GET' }).handler(async (): Promise<PeersData> => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: adminPaths.peers } });
  if (session.role !== 'admin') return { access: 'not-admin' };
  if (session.view.siteRole !== 'admin') return { access: 'needs-two-factor' };
  const [peers, trusted] = await Promise.all([listPeers(), readSetting('modlog.trusted_instances')]);
  return { access: 'ok', peers, trusted };
});
