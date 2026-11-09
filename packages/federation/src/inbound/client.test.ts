import { describe, expect, test } from 'vitest';
import { clientAddress, peerOf } from './client.ts';

const headers = new Headers({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7', 'cf-connecting-ip': '192.0.2.9' });

describe('the address of the client', () => {
  test('with no proxy named it is the peer, whatever the headers claim', () => {
    expect(clientAddress(headers, '10.0.0.5', undefined)).toBe('10.0.0.5');
    expect(clientAddress(headers, '10.0.0.5', 'none')).toBe('10.0.0.5');
    expect(clientAddress(headers, '10.0.0.5', 'something else')).toBe('10.0.0.5');
  });

  test('Traefik: the last X-Forwarded-For entry, the peer it saw', () => {
    expect(clientAddress(headers, '10.0.0.2', 'traefik')).toBe('203.0.113.7');
  });

  test('Cloudflare: CF-Connecting-IP', () => {
    expect(clientAddress(headers, '10.0.0.2', 'cloudflare')).toBe('192.0.2.9');
  });

  test('a missing header falls back to the peer, and no peer is no address', () => {
    expect(clientAddress(new Headers(), '10.0.0.2', 'traefik')).toBe('10.0.0.2');
    expect(clientAddress(new Headers(), undefined, 'traefik')).toBeNull();
  });

  test('the peer is what the server attached to the request, when it did', () => {
    expect(peerOf(new Request('https://a.test/'))).toBeUndefined();
    expect(peerOf(Object.assign(new Request('https://a.test/'), { ip: '10.0.0.8' }))).toBe('10.0.0.8');
  });
});
