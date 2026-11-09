import { describe, expect, test, vi } from 'vitest';
import { withFederation } from './federation.ts';

// The connection's peer, as TanStack Start's getRequestIP gives it inside a request.
vi.mock('@tanstack/react-start/server', async (original) => ({
  ...(await original<typeof import('@tanstack/react-start/server')>()),
  getRequestIP: () => '10.0.0.2',
}));

const ui = async (request: Request) =>
  new Response(`<!doctype html> accept=${request.headers.get('accept')}`, { headers: { 'content-type': 'text/html' } });
const json = 'application/activity+json';
const get = (path: string, accept = 'text/html') => new Request(`https://feddit.test${path}`, { headers: { accept } });

describe('federation bridge', () => {
  test('federation answers its requests before the UI, and a negotiated page says Vary: Accept', async () => {
    const fetch = withFederation(ui, async () => Response.json({ type: 'Person' }));
    const actor = await fetch(get('/u/andrew', json));
    expect(await actor.json()).toEqual({ type: 'Person' });
    expect(actor.headers.get('vary')).toBe('Accept');
    const webfinger = await fetch(get('/.well-known/webfinger'));
    expect(await webfinger.json()).toEqual({ type: 'Person' });
    expect(webfinger.headers.get('vary')).toBeNull();
  });

  test("federation's own Vary is kept, not doubled", async () => {
    const fetch = withFederation(ui, async () => Response.json({}, { headers: { vary: 'Accept, Accept-Encoding' } }));
    expect((await fetch(get('/c/news', json))).headers.get('vary')).toBe('Accept, Accept-Encoding');
  });

  test('a declined request renders the page as HTML, with Vary: Accept', async () => {
    const fetch = withFederation(ui, async () => null);
    const page = await fetch(get('/u/andrew', json));
    expect(await page.text()).toBe('<!doctype html> accept=text/html');
    expect(page.headers.get('vary')).toBe('Accept');
  });

  test('other requests never reach federation; browser requests for a negotiated page still vary', async () => {
    const fetch = withFederation(ui, async () => {
      throw new Error('federation was asked');
    });
    const health = await fetch(get('/healthz', json));
    expect(health.headers.get('vary')).toBeNull();
    const page = await fetch(get('/u/andrew'));
    expect(await page.text()).toBe('<!doctype html> accept=text/html');
    expect(page.headers.get('vary')).toBe('Accept');
  });

  describe('the address an inbox POST is counted by', () => {
    const forwarded = { 'x-forwarded-for': '10.9.9.9, 203.0.113.1', 'cf-connecting-ip': '192.0.2.9' };
    const postFrom = async (proxy: string | undefined, path = '/inbox', method = 'POST') => {
      if (proxy) vi.stubEnv('PEBLISH_TRUSTED_PROXY', proxy);
      try {
        const peers: (string | undefined)[] = [];
        const fetch = withFederation(ui, async (_request, context) => {
          peers.push(context?.peer);
          return new Response(null, { status: 202 });
        });
        await fetch(new Request(`https://feddit.test${path}`, { method, headers: forwarded, body: method === 'POST' ? '{}' : undefined }));
        return peers;
      } finally {
        vi.unstubAllEnvs();
      }
    };

    test('behind Traefik it is the forwarded client, behind Cloudflare its header', async () => {
      expect(await postFrom('traefik')).toEqual(['203.0.113.1']);
      expect(await postFrom('cloudflare')).toEqual(['192.0.2.9']);
    });

    test('with no proxy named it is the connection’s peer, whatever the headers claim', async () => {
      expect(await postFrom(undefined)).toEqual(['10.0.0.2']);
    });

    test('a misconfigured proxy setting is logged and the inbox still answers', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await postFrom('nginx')).toEqual([undefined]);
        expect(logged).toHaveBeenCalledOnce();
      } finally {
        logged.mockRestore();
      }
    });

    test('a document request is handed none', async () => {
      expect(await postFrom('traefik', '/ap/u.alice', 'GET')).toEqual([undefined]);
    });
  });
});
