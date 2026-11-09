import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

const generate = promisify(generateKeyPair);

/** A new RSA-2048 signing keypair as PEM: SPKI public key, PKCS#8 private key. */
export async function newRsaKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const { publicKey, privateKey } = await generate('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}
