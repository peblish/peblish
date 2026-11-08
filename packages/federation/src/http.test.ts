import { describe, expect, test } from 'vitest';
import { isFederationRequest, prefersActivityJson } from './http.ts';

const request = (path: string, accept?: string) => new Request(`https://feddit.test${path}`, { headers: accept ? { accept } : {} });
const activity = 'application/activity+json';
const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('federation routing', () => {
  test.each([
    '/ap/posts/1',
    '/.well-known/webfinger',
    '/.well-known/nodeinfo',
    '/nodeinfo/2.1',
    '/inbox',
    '/outbox',
    '/u/andrew/inbox',
    '/c/announcements/outbox',
  ])('%s always goes to federation', (path) => {
    expect(isFederationRequest(request(path, browser))).toBe(true);
  });

  test.each(['/', '/u/andrew', '/c/announcements'])('%s goes to federation only when ActivityPub is asked for', (path) => {
    expect(isFederationRequest(request(path, activity))).toBe(true);
    expect(isFederationRequest(request(path, 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'))).toBe(true);
    expect(isFederationRequest(request(path, browser))).toBe(false);
    expect(isFederationRequest(request(path))).toBe(false);
  });

  test.each(['/healthz', '/u/andrew/posts', '/c', '/apx', '/.well-known/host-meta'])('%s stays with the UI', (path) => {
    expect(isFederationRequest(request(path, activity))).toBe(false);
  });

  test('Accept quality values decide', () => {
    expect(prefersActivityJson(`${activity};q=0`)).toBe(false);
    expect(prefersActivityJson(`text/html, ${activity};q=0.5`)).toBe(false);
    expect(prefersActivityJson(`text/html;q=0.5, ${activity}`)).toBe(true);
    expect(prefersActivityJson('*/*')).toBe(false);
  });
});
