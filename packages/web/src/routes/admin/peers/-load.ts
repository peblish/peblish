import { listPeers, type PeerRow } from '@peblish/core/peers/read';
import { readSetting } from '@peblish/core/settings/read';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { pageSession } from '../../../server/auth.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { type Access, accessOf } from '../settings/-access.ts';

export type PeersData = { access: Exclude<Access, 'ok'> } | { access: 'ok'; peers: PeerRow[]; trusted: string[] };

export const loadPeers = createServerFn({ method: 'GET' }).handler(async (): Promise<PeersData> => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: adminPaths.peers } });
  // Signed in but not an admin whose session passed two-factor: the denial copy, answered as a 403 (as the report queue does).
  const access = accessOf(session);
  if (access !== 'ok') {
    setResponseStatus(403);
    return { access };
  }
  const [peers, trusted] = await Promise.all([listPeers(), readSetting('modlog.trusted_instances')]);
  return { access: 'ok', peers, trusted };
});
