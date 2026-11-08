import { describe, expect, test } from 'vitest';
import { withFederation } from './federation.ts';

const ui = async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
const json = 'application/activity+json';
const get = (path: string, accept = 'text/html') => new Request(`https://feddit.test${path}`, { headers: { accept } });

describe('federation bridge', () => {
  test('federation answers its requests before the UI', async () => {
    const fetch = withFederation(ui, async () => Response.json({ type: 'Person' }));
    expect(await (await fetch(get('/u/andrew', json))).json()).toEqual({ type: 'Person' });
    expect(await (await fetch(get('/.well-known/webfinger'))).json()).toEqual({ type: 'Person' });
  });

  test('a null answer falls through to the UI, and negotiated pages vary by Accept', async () => {
    const fetch = withFederation(ui, async () => null);
    const page = await fetch(get('/u/andrew', json));
    expect(await page.text()).toBe('<!doctype html>');
    expect(page.headers.get('vary')).toBe('Accept');
  });

  test('other requests never reach federation', async () => {
    const fetch = withFederation(ui, async () => {
      throw new Error('federation was asked');
    });
    const page = await fetch(get('/healthz', json));
    expect(page.headers.get('vary')).toBeNull();
    expect(await (await fetch(get('/u/andrew'))).text()).toBe('<!doctype html>');
  });
});
