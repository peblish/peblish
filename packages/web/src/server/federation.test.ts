import { describe, expect, test } from 'vitest';
import { withFederation } from './federation.ts';

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
});
