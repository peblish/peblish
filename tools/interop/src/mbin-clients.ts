// Mbin's API users are OAuth2 clients: a `client_credentials` client comes with its own bot user
// (Mbin creates it with the client), so seeding a user means creating a client. The credentials
// are kept in the results folder, which lives only as long as the lab's volumes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { http, MBIN, RESULTS_DIR } from './lab.ts';

export type MbinClient = { identifier: string; secret: string };

const file = () => `${RESULTS_DIR}/mbin-clients.json`;

export function readClients(): Record<string, MbinClient> {
  return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Record<string, MbinClient>) : {};
}

/** Scopes asked for: everything an ordinary or moderating user may use; no `admin:*`. */
export const scopes = [
  'read',
  'write',
  'delete',
  'subscribe',
  'block',
  'vote',
  'report',
  'domain',
  'entry',
  'entry:create',
  'entry:edit',
  'entry:delete',
  'entry:vote',
  'entry:report',
  'entry_comment',
  'entry_comment:create',
  'entry_comment:edit',
  'entry_comment:delete',
  'entry_comment:vote',
  'entry_comment:report',
  'magazine',
  'magazine:subscribe',
  'magazine:block',
  'post',
  'post:create',
  'post:edit',
  'post:delete',
  'post:vote',
  'post:report',
  'post_comment',
  'post_comment:create',
  'post_comment:edit',
  'post_comment:delete',
  'post_comment:vote',
  'post_comment:report',
  'user',
  'user:profile',
  'user:profile:read',
  'user:profile:edit',
  'user:follow',
  'user:block',
  'moderate',
  'moderate:entry',
  'moderate:entry:pin',
  'moderate:entry:lock',
  'moderate:entry:trash',
  'moderate:entry_comment',
  'moderate:entry_comment:trash',
  'moderate:magazine',
  'moderate:magazine:ban',
  'moderate:magazine:ban:read',
  'moderate:magazine:ban:create',
  'moderate:magazine:ban:delete',
  'moderate:magazine:list',
  'moderate:magazine:reports',
  'moderate:magazine:reports:read',
  'moderate:magazine:reports:action',
  'moderate:magazine:trash:read',
  'moderate:magazine_admin',
  'moderate:magazine_admin:create',
  'moderate:magazine_admin:delete',
  'moderate:magazine_admin:update',
  'moderate:magazine_admin:moderators',
  'admin',
  'admin:user',
  'admin:user:verify',
  'admin:user:delete',
  'admin:user:ban',
];

/** Creates the bot user and its client once; later calls return the stored credentials. */
export async function ensureClient(username: string): Promise<MbinClient> {
  const stored = readClients()[username];
  if (stored) return stored;
  const created = await http<{ identifier: string; secret: string }>('POST', `${MBIN}/api/client`, {
    body: {
      name: `lab ${username}`,
      contactEmail: `${username}@mbin.lab.test`,
      description: 'peblish interop lab',
      public: false,
      username,
      redirectUris: [],
      grants: ['client_credentials'],
      scopes,
    },
  });
  const client = { identifier: created.identifier, secret: created.secret };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(file(), `${JSON.stringify({ ...readClients(), [username]: client }, null, 2)}\n`);
  return client;
}

/** A bearer token for a seeded user. */
export async function mbinToken(username: string): Promise<string> {
  const client = readClients()[username];
  if (!client) throw new Error(`no Mbin client for ${username}; run make seed`);
  const { access_token } = await http<{ access_token: string }>('POST', `${MBIN}/token`, {
    form: { grant_type: 'client_credentials', client_id: client.identifier, client_secret: client.secret, scope: scopes.join(' ') },
  });
  return access_token;
}
