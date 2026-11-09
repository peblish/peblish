import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { bytes } from '../media/__fixtures__/images.ts';
import { startArachnidStub, type ArachnidStub } from '../testing/seed-safe.ts';
import { arachnidProvider } from './arachnid.ts';
import { ScanError, type ScanInput } from './provider.ts';

let stub: ArachnidStub;
beforeAll(async () => {
  stub = await startArachnidStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.onMedia(() => ({ json: { classification: 'no-known-match' } }));
  stub.onVersion({ json: { version: 'v42' } });
});

const png = bytes('png');
const input: ScanInput = { bytes: png, mimeType: 'image/png', sha256: 'unused' };
const provider = () => arachnidProvider({ baseUrl: stub.baseUrl, username: stub.username, password: stub.password });
const signal = () => AbortSignal.timeout(2000);

test('a scan is one POST of the raw bytes to /v1/media with Basic auth and the sniffed image type', async () => {
  await provider().scan(input, signal());
  expect(stub.requests).toHaveLength(1);
  const [request] = stub.requests;
  expect(request).toMatchObject({ method: 'POST', path: '/v1/media', contentType: 'image/png' });
  expect(request!.authorization).toBe(`Basic ${Buffer.from(`${stub.username}:${stub.password}`).toString('base64')}`);
  expect(request!.body.equals(Buffer.from(png))).toBe(true);
});

test('every classification maps to a verdict, and the stored answer is the one received', async () => {
  const cases = [
    [{ classification: 'no-known-match' }, { result: 'no-match' }],
    [
      { classification: 'csam', match_type: 'exact' },
      { result: 'match', classification: 'csam', matchType: 'exact', raw: { classification: 'csam', match_type: 'exact' } },
    ],
    [
      { classification: 'harmful-abusive-material' },
      { result: 'match', classification: 'harmful-abusive-material', matchType: null, raw: { classification: 'harmful-abusive-material' } },
    ],
    // The harmless drill image: quarantined like any match, classified test so no report is due.
    [{ classification: 'test' }, { result: 'match', classification: 'test', matchType: null, raw: { classification: 'test' } }],
    [
      { classification: 'csam', match_type: 'near' },
      { result: 'match', classification: 'csam', matchType: 'near', raw: { classification: 'csam', match_type: 'near' } },
    ],
    [
      { classification: 'csam', near_match_details: [{ distance: 3 }] },
      {
        result: 'match',
        classification: 'csam',
        matchType: 'near',
        raw: { classification: 'csam', near_match_details: [{ distance: 3 }] },
      },
    ],
  ] as const;
  for (const [answer, verdict] of cases) {
    stub.onMedia(() => ({ json: answer }));
    expect(await provider().scan(input, signal()), JSON.stringify(answer)).toEqual(verdict);
  }
});

test('an oversize answer keeps only its classification', async () => {
  stub.onMedia(() => ({
    json: { classification: 'csam', near_match_details: Array.from({ length: 700 }, (_, i) => ({ i, pad: 'x'.repeat(20) })) },
  }));
  const verdict = await provider().scan(input, signal());
  expect(verdict).toMatchObject({ result: 'match', matchType: 'near', raw: { classification: 'csam', truncated: true } });
  // Past 64 KiB the answer is not read at all.
  stub.onMedia(() => ({ text: JSON.stringify({ classification: 'csam', pad: 'x'.repeat(70_000) }) }));
  await expect(provider().scan(input, signal())).rejects.toThrow(new ScanError('Arachnid answer too large'));
});

test('a non-2xx status, bad JSON, an unknown classification and a redirect are ScanErrors that carry no credential', async () => {
  const wrong = arachnidProvider({ baseUrl: stub.baseUrl, username: stub.username, password: 'wrong-pw-1234' });
  const attempts: [string, () => Promise<unknown>][] = [
    ['401', () => wrong.scan(input, signal())],
    ['500', async () => (stub.onMedia(() => ({ status: 500, json: {} })), provider().scan(input, signal()))],
    ['html', async () => (stub.onMedia(() => ({ text: '<html>' })), provider().scan(input, signal()))],
    ['unknown', async () => (stub.onMedia(() => ({ json: { classification: 'perhaps' } })), provider().scan(input, signal()))],
    [
      'redirect',
      async () => (
        stub.onMedia(() => ({ status: 302, headers: { location: `${stub.baseUrl}/elsewhere` } })),
        provider().scan(input, signal())
      ),
    ],
  ];
  for (const [label, attempt] of attempts) {
    const error = await attempt().catch((e: unknown) => e);
    expect([label, error instanceof ScanError]).toEqual([label, true]);
    expect(String(error), label).not.toMatch(new RegExp(`${stub.password}|wrong-pw-1234|Basic|${stub.baseUrl}`));
  }
  // The redirect was never followed, so the Authorization header never travelled to the Location.
  expect(stub.requests.some((r) => r.path === '/elsewhere')).toBe(false);
});

test('a signal that aborts stops the request as a timeout', async () => {
  stub.onMedia(() => ({ delayMs: 500, json: { classification: 'no-known-match' } }));
  await expect(provider().scan(input, AbortSignal.timeout(40))).rejects.toThrow(new ScanError('Arachnid request timed out'));
});

test('version asks GET /v1/version and returns a short string', async () => {
  expect(await provider().version!(signal())).toBe('{"version":"v42"}');
  expect(stub.requests.map((r) => [r.method, r.path])).toEqual([['GET', '/v1/version']]);
});

test('the fetch is injectable, and a provider never contacts any host but its base URL', async () => {
  const seen: string[] = [];
  const fake = vi.fn(async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ classification: 'no-known-match' }), { status: 200 });
  });
  const global = vi.spyOn(globalThis, 'fetch');
  await arachnidProvider({ baseUrl: 'http://127.0.0.1:1', username: 'u', password: 'p', fetch: fake as unknown as typeof fetch }).scan(
    input,
    signal(),
  );
  expect(seen).toEqual(['http://127.0.0.1:1/v1/media']);
  expect(global).not.toHaveBeenCalled();
  global.mockRestore();
});
