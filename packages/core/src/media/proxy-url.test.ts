import { expect, test } from 'vitest';
import { derivedKey } from '../identity/auth.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { imageSource, isImageContentType } from './image-src.ts';
import { mediaProxyKey, proxyUrlBuilder, verifyProxyPath } from './proxy-url.ts';

const key = Buffer.from('a'.repeat(32));
const build = proxyUrlBuilder(key);
const split = (path: string) => path.split('/').slice(3) as [string, string];
const URL_ = 'https://img.lemmy.example/pictrs/image/a-b.webp?format=webp&thumbnail=256';

test('a proxy path carries its URL and verifies only under its own key', () => {
  const path = build(URL_);
  expect(path).toMatch(/^\/media\/proxy\/[\w-]{43}\/[\w-]+$/);
  const [signature, target] = split(path);
  expect(verifyProxyPath(key, signature, target)).toBe(URL_);
  expect(verifyProxyPath(Buffer.from('b'.repeat(32)), signature, target)).toBeNull();
});

test('an unsigned, altered or hand-made path is refused: signature, target, case, truncation', () => {
  const [signature, target] = split(build(URL_));
  const other = Buffer.from('https://internal.example/admin').toString('base64url');
  const forged = [
    ['', target],
    [signature, ''],
    [signature, other],
    [signature.slice(0, -1), target],
    [`${signature}A`, target],
    [signature.replace(/^./, signature.startsWith('A') ? 'B' : 'A'), target],
    [signature, `${target}A`],
    [signature.toLowerCase() === signature ? signature.toUpperCase() : signature.toLowerCase(), target],
    ['x'.repeat(43), target],
  ] as const;
  for (const [s, t] of forged) expect(verifyProxyPath(key, s, t), `${s}/${t}`).toBeNull();
});

test('only absolute http and https URLs without credentials are ever signed through', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'ftp://x.example/a',
    '//x.example/a',
    'relative/a.png',
    'https://u:p@x.example/a.png',
  ]) {
    const [signature, target] = split(build(url));
    expect(verifyProxyPath(key, signature, target), url).toBeNull();
  }
  expect(() => build(`https://x.example/${'a'.repeat(3000)}`)).toThrow(RangeError);
});

test('the length limit is 2,048 UTF-8 bytes on both sides: what the builder signs, verify takes back', () => {
  const host = 'https://x.example/';
  const urlOf = (bytes: number, letter: string) => {
    // As many of `letter` (1 to 4 bytes) as fit, padded with ASCII to exactly `bytes` bytes.
    const count = Math.floor((bytes - host.length) / Buffer.byteLength(letter));
    return `${host}${letter.repeat(count)}${'a'.repeat(bytes - host.length - count * Buffer.byteLength(letter))}`;
  };
  for (const letter of ['a', 'é', '画', '😀']) {
    const exact = urlOf(2048, letter);
    expect(Buffer.byteLength(exact), letter).toBe(2048);
    const [signature, target] = split(build(exact));
    expect(verifyProxyPath(key, signature, target), letter).toBe(exact);
    expect(() => build(`${exact}a`), letter).toThrow(RangeError);
  }
  // Under 2,048 UTF-16 units, over 2,048 bytes: the builder used to sign this and verify then refused it.
  const wide = `${host}${'é'.repeat(1200)}`;
  expect(wide.length).toBeLessThan(2048);
  expect(() => build(wide)).toThrow(RangeError);
});

test('the key comes from the auth secret under its own purpose label', async () => {
  await seedLocalInstance();
  const proxy = await mediaProxyKey();
  expect(proxy.equals(await mediaProxyKey())).toBe(true);
  expect(proxy.equals(await derivedKey('invite-codes'))).toBe(false);
  expect(proxy).toHaveLength(32);
});

test('where an image loads from: this instance as is, remote only through the proxy and the kill switch', () => {
  const policy = { origin: 'https://feddit.example', remoteMedia: true, proxy: build };
  expect(imageSource('https://feddit.example/media/a.png', policy)).toBe('https://feddit.example/media/a.png');
  expect(imageSource(URL_, policy)).toBe(build(URL_));
  const refused = [
    imageSource(URL_, { ...policy, remoteMedia: false }),
    imageSource(URL_, { ...policy, proxy: undefined }),
    imageSource('javascript:alert(1)', policy),
    imageSource('data:image/png;base64,AAAA', policy),
    imageSource('not a url', policy),
    imageSource(`https://x.example/${'a'.repeat(3000)}`, policy),
    imageSource(null, policy),
    imageSource(undefined, policy),
  ];
  expect(refused).toEqual(Array(refused.length).fill(null));
  // Own media stays loadable with the switch off.
  expect(imageSource('https://feddit.example/media/a.png', { ...policy, remoteMedia: false, proxy: undefined })).toBe(
    'https://feddit.example/media/a.png',
  );
});

test('a post link is an image when its content type says so, including the image/* placeholder', () => {
  for (const type of ['image/png', 'image/jpeg', 'IMAGE/WebP', 'image/*', ' image/gif ']) expect(isImageContentType(type), type).toBe(true);
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'imagery/png', '', null, undefined])
    expect(isImageContentType(type), String(type)).toBe(false);
});
