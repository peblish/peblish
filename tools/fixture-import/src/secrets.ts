// The guard every generated fixture file passes: no private key material and no email
// addresses. Fediverse handles (@user@host, !community@host) and addresses inside URLs
// (PieFed's /c/name@host/p/... post ids) look like emails and are allowed; a bare
// user@host is not.

const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const email = /(?<![@!/\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const forbiddenKeys = new Set(['privatekey', 'private_key', 'privatekeypem', 'email', 'password', 'password_hash']);

/** Where in `value` a secret appears, as JSON paths with what was found; empty when clean. */
export function findSecrets(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const found: string[] = [];
    if (privateKey.test(value)) found.push(`${path}: private key`);
    const address = email.exec(value);
    if (address) found.push(`${path}: email address ${address[0]}`);
    return found;
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecrets(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(forbiddenKeys.has(key.toLowerCase()) ? [`${path}.${key}: forbidden field`] : []),
      ...findSecrets(item, `${path}.${key}`),
    ]);
  }
  return [];
}
