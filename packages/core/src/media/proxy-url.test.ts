import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { derivedKey } from '../identity/auth.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { imageSource, isImageContentType } from './image-src.ts';
import { mediaProxyKey, proxyUrlBuilder, unwrapProxyUrl, verifyProxyPath } from './proxy-url.ts';

const key = Buffer.from('a'.repeat(32));
const build = proxyUrlBuilder(key);
const split = (path: string) => path.split('/').slice(3) as [string, string];
const URL_ = 'https://img.lemmy.example/pictrs/image/a-b.webp?format=webp&thumbnail=256';

test('a proxy path carries its URL and verifies only under its own key', () => {
  const path = build(URL_);
  expect(path).toMatch(/^\/media\/proxy\/[\w-]{43}\/[\w-]+$/);
  const [signature, target] = split(path);
  expect(verifyProxyPath(key, signature, target)).toEqual({ url: URL_, content: null });
  expect(verifyProxyPath(Buffer.from('b'.repeat(32)), signature, target)).toBeNull();
});

test('a path names the content it was signed for, and an unbound one expires at the end of the next hour', () => {
  const comment = { kind: 'comment', id: '0195F0A0-0000-7000-8000-00000000000C', supplier: 'Lemmy.Example:8443' } as const;
  const [signature, target] = split(build(URL_, comment));
  expect(verifyProxyPath(key, signature, target)).toEqual({
    url: URL_,
    content: { kind: 'comment', id: comment.id.toLowerCase(), supplier: 'lemmy.example:8443' },
  });
  expect(verifyProxyPath(key, ...split(build(URL_, { ...comment, supplier: null })))?.content?.supplier).toBeNull();
  for (const kind of ['post', 'actor'] as const)
    expect(verifyProxyPath(key, ...split(build(URL_, { ...comment, kind })))?.content?.kind).toBe(kind);
  // A bound path never expires: it lives as long as its content is shown (reference.ts).
  expect(verifyProxyPath(key, signature, target, Date.UTC(2100, 0, 1))?.content?.kind).toBe('comment');

  const issued = Date.UTC(2026, 10, 10, 9, 30);
  const [s, t] = split(proxyUrlBuilder(key, () => issued)(URL_));
  expect(verifyProxyPath(key, s, t, Date.UTC(2026, 10, 10, 10, 59, 59))).toEqual({ url: URL_, content: null });
  expect(verifyProxyPath(key, s, t, Date.UTC(2026, 10, 10, 11))).toBeNull();
  // The same URL within the hour, so a page's images stay in the browser's cache.
  expect(proxyUrlBuilder(key, () => issued + 20 * 60_000)(URL_)).toBe(proxyUrlBuilder(key, () => issued)(URL_));
  // A path in the old form (the URL alone, signed) carries no reference and is refused.
  const old = Buffer.from(URL_).toString('base64url');
  expect(verifyProxyPath(key, createHmac('sha256', key).update(URL_).digest('base64url'), old)).toBeNull();
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
    expect(verifyProxyPath(key, signature, target)?.url, letter).toBe(exact);
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

test('where an image loads from: this instance as a root-relative path, remote only through the proxy and the kill switch', () => {
  const policy = { origin: 'https://feddit.example', remoteMedia: true, proxy: build };
  // The viewer may reach the instance under another host than the stored origin, so the host is dropped.
  expect(imageSource('https://feddit.example/media/a.png', policy)).toBe('/media/a.png');
  expect(imageSource('https://feddit.example/media/a.png?v=2', policy)).toBe('/media/a.png?v=2');
  expect(imageSource('https://feddit.example:8443/media/a.png', policy)).toBe(build('https://feddit.example:8443/media/a.png'));
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
  expect(imageSource('https://feddit.example/media/a.png', { ...policy, remoteMedia: false, proxy: undefined })).toBe('/media/a.png');
});

test('an own-origin URL whose path would leave the host takes the proxy branch, or null with the switch off', () => {
  const policy = { origin: 'https://feddit.example', remoteMedia: true, proxy: build };
  const leaving = [
    'https://feddit.example//evil.example/x.png',
    'https://feddit.example/\\evil.example/x.png', // the URL parser turns the backslash into a slash
    'https://feddit.example/.//evil.example/x.png',
    'https://feddit.example/a/..//evil.example/x.png',
  ];
  for (const url of leaving) {
    expect(imageSource(url, policy), url).toBe(build(url));
    expect(imageSource(url, { ...policy, remoteMedia: false }), url).toBeNull();
  }
  // These stay on the host: a query that looks like a host, and an encoded slash (browsers do not decode it).
  for (const [url, path] of [
    ['https://feddit.example/?//evil.example/x.png', '/?//evil.example/x.png'],
    ['https://feddit.example?//evil.example/x.png', '/?//evil.example/x.png'],
    ['https://feddit.example/%2f/x.png', '/%2f/x.png'],
    ['https://feddit.example/%5Cevil.example/x.png', '/%5Cevil.example/x.png'],
  ] as const)
    expect(imageSource(url, policy), url).toBe(path);
});

test('an image shown for content a denied peer supplied never loads, wherever it is hosted; the supplier is signed in', () => {
  const policy = { origin: 'https://feddit.example', remoteMedia: true, proxy: build, deniedDomains: ['piefed.example'] };
  const remote = { kind: 'post', id: '0195f0a0-0000-7000-8000-000000000001', apId: 'https://piefed.example/post/1' } as const;
  // The image host is no peer (a plain website), so only the supplier can refuse it.
  const offHost = 'https://images.example/a.png';
  expect(imageSource(offHost, policy, remote)).toBeNull();
  expect(imageSource(offHost, policy, { ...remote, apId: 'https://sub.piefed.example/post/1' })).toBeNull();
  const approved = { ...remote, apId: 'https://lemmy.example/post/1' };
  const [signature, target] = split(imageSource(offHost, policy, approved)!);
  expect(verifyProxyPath(key, signature, target)?.content).toEqual({ kind: 'post', id: remote.id, supplier: 'lemmy.example' });
  // This instance's own content names no supplier.
  const own = split(imageSource(offHost, policy, { ...remote, apId: 'https://feddit.example/post/1' })!);
  expect(verifyProxyPath(key, ...own)?.content?.supplier).toBeNull();
  // Content whose ap_id is not a URL has no supplier to judge, so its images do not load.
  expect(imageSource(offHost, policy, { ...remote, apId: 'not a url' })).toBeNull();
});

test('a copied proxy path is signed again for the content it is shown in now, never kept as it stands (CN1)', () => {
  const policy = {
    origin: 'https://feddit.example',
    remoteMedia: true,
    proxy: build,
    unwrap: (url: URL) => unwrapProxyUrl(key, url),
    deniedDomains: ['piefed.example'],
  };
  const a = { kind: 'post', id: '0195f0a0-0000-7000-8000-00000000000a', apId: 'https://lemmy.example/post/a' } as const;
  const b = { kind: 'post', id: '0195f0a0-0000-7000-8000-00000000000b', apId: 'https://lemmy.example/post/b' } as const;
  const signedForA = imageSource(URL_, policy, a)!;
  const contentOf = (path: string) => verifyProxyPath(key, ...split(path));
  // Copied into B, absolute or relative, on this origin or another host name for it, A's path becomes B's.
  for (const copy of [
    `https://feddit.example${signedForA}`,
    `https://www.feddit.example${signedForA}`,
    `https://feddit.example${signedForA.toUpperCase().slice(0, 13)}${signedForA.slice(13)}`,
    `https://feddit.example${signedForA.replace('proxy', '%70roxy')}`,
  ]) {
    const path = imageSource(copy, policy, b);
    expect(path, copy).toBe(imageSource(URL_, policy, b));
    expect(contentOf(path!), copy).toEqual({ url: URL_, content: { kind: 'post', id: b.id, supplier: 'lemmy.example' } });
  }
  // A path wrapped twice unwraps to the image; one with no content signs an expiring reference.
  expect(imageSource(`https://feddit.example${build(`https://feddit.example${signedForA}`, null)}`, policy, b)).toBe(
    imageSource(URL_, policy, b),
  );
  expect(contentOf(imageSource(`https://feddit.example${signedForA}`, policy)!)?.content).toBeNull();
  // The supplier is judged first: B from a denied peer shows nothing, A's path and this instance's own media included.
  const denied = { ...b, apId: 'https://piefed.example/post/b' };
  expect(imageSource(`https://feddit.example${signedForA}`, policy, denied)).toBeNull();
  expect(imageSource('https://feddit.example/media/0195f0a0-0000-7000-8000-000000000001', policy, denied)).toBeNull();
  // A proxy path under this origin that is not ours, or with no way to read it, is dropped; another instance's is any remote image.
  const forged = `https://feddit.example/media/proxy/${'A'.repeat(43)}/${split(signedForA)[1]}`;
  expect(imageSource(forged, policy, b)).toBeNull();
  expect(imageSource(`https://feddit.example${signedForA}`, { ...policy, unwrap: undefined }, b)).toBeNull();
  const theirs = `https://other.example${proxyUrlBuilder(Buffer.from('o'.repeat(32)))(URL_)}`;
  expect(contentOf(imageSource(theirs, policy, b)!)?.url).toBe(theirs);
  // Unwrapping judges the signature alone: an expired reference still carries its URL.
  const old = proxyUrlBuilder(key, () => 0)(URL_);
  expect(unwrapProxyUrl(key, new URL(`https://feddit.example${old}`))).toBe(URL_);
  expect(unwrapProxyUrl(key, new URL(`https://feddit.example${old}/extra`))).toBeNull();
  expect(unwrapProxyUrl(Buffer.from('z'.repeat(32)), new URL(`https://feddit.example${old}`))).toBeNull();
});

test('a post link is an image when its content type says so, including the image/* placeholder', () => {
  for (const type of ['image/png', 'image/jpeg', 'IMAGE/WebP', 'image/*', ' image/gif ']) expect(isImageContentType(type), type).toBe(true);
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'imagery/png', '', null, undefined])
    expect(isImageContentType(type), String(type)).toBe(false);
});
