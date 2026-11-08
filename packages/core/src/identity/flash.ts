import type { Uuid } from '@peblish/schema/ids';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { auth } from './auth.ts';

// A value for one session's next page view, then gone: how a form's result that must be shown
// once (a new invite's code) reaches the page its POST redirects to, without riding in the URL
// and so in browser history. Kept in better-auth's verification table for ten minutes at most,
// encrypted with the auth secret.

const identifier = (sessionId: Uuid, name: string) => `peblish-flash:${name}:${sessionId}`;

export async function putFlash(sessionId: Uuid, name: string, value: string): Promise<void> {
  const { internalAdapter, secretConfig } = await (await auth()).$context;
  await internalAdapter.createVerificationValue({
    identifier: identifier(sessionId, name),
    value: await symmetricEncrypt({ key: secretConfig, data: value }),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
}

/** The newest value put for this session under `name`, consuming it; null when there is none. */
export async function takeFlash(sessionId: Uuid, name: string): Promise<string | null> {
  const { internalAdapter, secretConfig } = await (await auth()).$context;
  const row = await internalAdapter.consumeVerificationValue(identifier(sessionId, name));
  return row ? symmetricDecrypt({ key: secretConfig, data: row.value }) : null;
}
